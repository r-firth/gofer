//! Rebuildable read index and bounded views over the actual Vecgra graph.
use crate::store::{Event, Store};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use vecgra::{Direction, EdgeFilter, ElementRef, Value as V, VectorTarget};

#[derive(Default)]
pub struct MemoryIndex {
    pub by_id: HashMap<u64, usize>,
    pub by_scope: HashMap<String, Vec<usize>>,
    titles: HashMap<String, String>,
    texts: Vec<String>,
    postings: HashMap<[u8; 3], Vec<usize>>,
    run_for: HashMap<u64, u64>,
    runs: HashMap<u64, Vec<usize>>,
    current: HashMap<String, u64>,
}
fn transport(kind: &str) -> bool {
    matches!(
        kind,
        "message.started" | "message.delta" | "tool.output" | "agent.status"
    )
}
pub fn category(kind: &str) -> &'static str {
    if kind.starts_with("message.") {
        "message"
    } else if kind.starts_with("tool.") {
        "tool"
    } else if kind.starts_with("terminal.") || kind.starts_with("session.") {
        "terminal"
    } else {
        "system"
    }
}
pub(crate) fn text_of(e: &Event) -> String {
    if let Some(text) = e.payload["text"].as_str() {
        return text.into();
    }
    if let Some(delta) = e.payload["delta"].as_str() {
        return delta.into();
    }
    let mut payload = e.payload.clone();
    if let Some(p) = payload.as_object_mut() {
        p.remove("bytes");
    }
    serde_json::to_string(&payload).unwrap_or_default()
}
pub(crate) fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}
impl MemoryIndex {
    pub fn add(&mut self, event: &Event, position: usize) {
        self.by_id.insert(event.id, position);
        let scope = self.by_scope.entry(event.scope.clone()).or_default();
        scope.push(position);
        if let Some(name) = event.payload["name"].as_str().filter(|_| {
            matches!(
                event.kind.as_str(),
                "chat.created" | "chat.renamed" | "session.created" | "device.saved"
            )
        }) {
            self.titles.insert(event.scope.clone(), name.into());
        }
        if event.kind == "message.user" || !self.current.contains_key(&event.scope) {
            self.current.insert(event.scope.clone(), event.id);
        }
        let run = self.current[&event.scope];
        self.run_for.insert(event.id, run);
        self.runs.entry(run).or_default().push(position);
        let text = text_of(event).to_lowercase();
        // The index contains searchable content, never terminal binary archives.
        let unique: HashSet<[u8; 3]> = text
            .as_bytes()
            .windows(3)
            .map(|w| [w[0], w[1], w[2]])
            .collect();
        for gram in unique {
            self.postings.entry(gram).or_default().push(position);
        }
        self.texts.push(text);
    }
    pub(crate) fn len(&self) -> usize {
        self.texts.len()
    }
    /// Positions whose indexed text contains `term` (lowercase).
    pub(crate) fn containing(&self, term: &str) -> Vec<usize> {
        self.candidates(term)
            .into_iter()
            .filter(|&i| self.texts[i].contains(term))
            .collect()
    }
    fn candidates(&self, query: &str) -> Vec<usize> {
        let grams: Vec<[u8; 3]> = query
            .split_whitespace()
            .flat_map(|t| t.as_bytes().windows(3).map(|w| [w[0], w[1], w[2]]))
            .collect();
        if grams.iter().any(|g| !self.postings.contains_key(g)) {
            return Vec::new();
        }
        if let Some(shortest) = grams
            .iter()
            .filter_map(|g| self.postings.get(g))
            .min_by_key(|p| p.len())
        {
            shortest
                .iter()
                .rev()
                .copied()
                .filter(|i| {
                    grams
                        .iter()
                        .all(|g| self.postings[g].binary_search(i).is_ok())
                })
                .collect()
        } else {
            (0..self.texts.len()).rev().collect()
        }
    }
}
impl Store {
    fn memory_event(&self, id: u64) -> Option<&Event> {
        self.memory.by_id.get(&id).map(|&i| &self.events[i])
    }
    pub(crate) fn scope_title(&self, scope: &str) -> String {
        self.memory
            .titles
            .get(scope)
            .cloned()
            .unwrap_or_else(|| scope.into())
    }
    fn memory_node(&self, id: u64) -> Option<Value> {
        let read = self.db.read();
        let node = read.node(id)?;
        let label = read.symbol(node.label).unwrap_or("Node");
        if let Some(c) = self.claims.get(&id) {
            return Some(
                json!({"id":id,"label":label,"kind":"claim","category":"claim","title":"Claim","state":c.state,"scope":c.scope,"scope_name":self.scope_title(&c.scope),"source":c.source,"about":c.about,"evidence":c.evidence,"time":c.created_at,"run_id":c.evidence.first().and_then(|e| self.memory.run_for.get(e)),"excerpt":c.text,"vectors":node.vector_count}),
            );
        }
        if label == "Entity" {
            let name = crate::claims::string(&read, &node.properties, "name");
            return Some(
                json!({"id":id,"label":label,"kind":"entity","category":"entity","title":name,"excerpt":"","vectors":node.vector_count}),
            );
        }
        if let Some(e) = self.memory_event(id) {
            let title = match e.kind.as_str() {
                "message.user" => "You".into(),
                "message.assistant" => "Coordinator".into(),
                "tool.started" | "tool.result" => e.payload["name"]
                    .as_str()
                    .unwrap_or("Tool")
                    .replace('_', " "),
                _ => e.kind.replace(['.', '_'], " "),
            };
            Some(
                json!({"id":id,"label":label,"kind":e.kind,"category":category(&e.kind),"title":title,"scope":e.scope,"scope_name":self.scope_title(&e.scope),"time":e.time,"run_id":self.memory.run_for.get(&id),"excerpt":clip(&text_of(e),240),"vectors":node.vector_count}),
            )
        } else {
            let scope = node
                .properties
                .iter()
                .find_map(|p| {
                    if read.symbol(p.key) == Some("scope_id") {
                        if let V::String(s) = &p.value {
                            Some(s.as_ref())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                })
                .unwrap_or("");
            Some(
                json!({"id":id,"label":label,"kind":"scope","category":"scope","scope":scope,"scope_name":self.scope_title(scope),"title":self.scope_title(scope),"excerpt":"","vectors":node.vector_count}),
            )
        }
    }
    pub fn memory_search(
        &self,
        query: &str,
        kind: &str,
        offset: usize,
        vector: Option<&[f32]>,
    ) -> Result<Value> {
        let query = query.trim().to_lowercase();
        let tokens: Vec<_> = query.split_whitespace().collect();
        let claims = kind == "all" || kind == "claim";
        let accepts = |id: u64| match self.memory.by_id.get(&id) {
            Some(&i) => {
                let e = &self.events[i];
                kind != "claim"
                    && (!transport(&e.kind) || kind == "raw")
                    && (kind == "all" || kind == "raw" || category(&e.kind) == kind)
            }
            None => claims && self.claims.contains_key(&id),
        };
        // Lexical results already arrive newest-first from the postings index.
        // Avoid sorting or hashing the entire archive for the common text path.
        let mut lexical: Vec<_> = if kind == "claim" {
            Vec::new()
        } else {
            self.memory
                .candidates(&query)
                .into_iter()
                .filter(|&i| tokens.iter().all(|t| self.memory.texts[i].contains(t)))
                .map(|i| self.events[i].id)
                .filter(|&id| accepts(id))
                .map(|id| (id, 1.0_f32))
                .collect()
        };
        if claims {
            let mut matched: Vec<_> = self
                .claims
                .iter()
                .filter(|(_, c)| {
                    let text = c.text.to_lowercase();
                    tokens.iter().all(|t| text.contains(t))
                })
                .map(|(&id, _)| (id, 1.0_f32))
                .collect();
            if !matched.is_empty() {
                lexical.append(&mut matched);
                lexical.sort_unstable_by_key(|hit| std::cmp::Reverse(hit.0));
            }
        }
        let ranked = if let Some(v) = vector {
            let mut ranked: HashMap<u64, f32> = lexical.into_iter().collect();
            for hit in self
                .db
                .read()
                .vector_search(v, VectorTarget::Nodes, 120, None)?
            {
                if let ElementRef::Node(id) = hit.element
                    && accepts(id)
                {
                    *ranked.entry(id).or_default() += hit.score.max(0.0);
                }
            }
            let mut ranked: Vec<_> = ranked.into_iter().collect();
            ranked.sort_unstable_by(|(a, sa), (b, sb)| sb.total_cmp(sa).then(b.cmp(a)));
            ranked
        } else {
            lexical
        };
        let total = ranked.len();
        let hits: Vec<_> = ranked
            .into_iter()
            .skip(offset)
            .take(40)
            .filter_map(|(id, score)| {
                let mut node = self.memory_node(id)?;
                let text = match self.memory_event(id) {
                    Some(e) => text_of(e),
                    None => self.claims[&id].text.clone(),
                };
                let lower = text.to_lowercase();
                let start = tokens.first().and_then(|t| lower.find(t)).unwrap_or(0);
                // Byte positions from lowercasing may differ; clip on UTF-8 boundaries.
                let start = text
                    .char_indices()
                    .map(|(i, _)| i)
                    .take_while(|i| *i <= start.saturating_sub(60))
                    .last()
                    .unwrap_or(0);
                let start = text[..start]
                    .rfind(char::is_whitespace)
                    .map(|i| i + text[i..].chars().next().unwrap().len_utf8())
                    .filter(|&i| start - i < 40)
                    .unwrap_or(start);
                let excerpt = clip(&text[start..], 260);
                node["excerpt"] = json!(format!(
                    "{}{}{}",
                    if start > 0 { "… " } else { "" },
                    excerpt,
                    if start + excerpt.len() < text.len() {
                        " …"
                    } else {
                        ""
                    }
                ));
                node["score"] = json!(score);
                Some(node)
            })
            .collect();
        let next = offset.saturating_add(40);
        Ok(json!({
            "hits": hits,
            "total": total,
            "next_offset": (next < total).then_some(next),
            "semantic": vector.is_some(),
        }))
    }
    pub fn memory_graph(&self, focus: Option<u64>, offset: usize) -> Result<Value> {
        let mut ids = HashSet::new();
        let mut total_context = 0;
        if let Some(id) = focus {
            let read = self.db.read();
            let node = read.node(id).context("Node not found")?;
            ids.insert(id);
            if let Some(scope) = self
                .scopes
                .iter()
                .find_map(|(s, &node)| if node == id { Some(s) } else { None })
            {
                if let Some(positions) = self.memory.by_scope.get(scope) {
                    total_context = positions.len();
                    ids.extend(
                        positions
                            .iter()
                            .rev()
                            .skip(offset)
                            .take(100)
                            .map(|&i| self.events[i].id),
                    );
                }
            } else if let Some(e) = self.memory_event(node.id) {
                if let Some(&root) = self.scopes.get(&e.scope) {
                    ids.insert(root);
                }
                let positions = &self.memory.by_scope[&e.scope];
                let p = positions
                    .binary_search(&self.memory.by_id[&id])
                    .unwrap_or(0);
                ids.extend(
                    positions[p.saturating_sub(12)..(p + 13).min(positions.len())]
                        .iter()
                        .map(|&i| self.events[i].id),
                );
                total_context = positions.len();
            } else if self.claims.contains_key(&id) {
                // A claim with its entities, evidence and supersession links.
                let neighbors = read.neighbors(id, Direction::Both, EdgeFilter::default())?;
                total_context = neighbors.len();
                ids.extend(
                    neighbors
                        .iter()
                        .map(|e| if e.source == id { e.target } else { e.source }),
                );
            } else if read.symbol(node.label) == Some("Entity") {
                let mut about: Vec<_> = read
                    .neighbors(id, Direction::Incoming, EdgeFilter::default())?
                    .iter()
                    .map(|e| e.source)
                    .collect();
                about.sort_unstable_by_key(|&id| std::cmp::Reverse(id));
                total_context = about.len();
                ids.extend(about.into_iter().skip(offset).take(100));
            }
        } else {
            let mut scopes: Vec<_> = self.memory.by_scope.iter().collect();
            scopes.sort_unstable_by_key(|(_, events)| {
                std::cmp::Reverse(events.last().copied().unwrap_or(0))
            });
            total_context = scopes.len();
            for (scope, positions) in scopes.into_iter().skip(offset).take(12) {
                if let Some(&id) = self.scopes.get(scope) {
                    ids.insert(id);
                }
                ids.extend(
                    positions
                        .iter()
                        .rev()
                        .filter(|&&i| !transport(&self.events[i].kind))
                        .take(12)
                        .map(|&i| self.events[i].id),
                );
            }
            ids.extend(self.claims.keys().rev().take(24));
        }
        let read = self.db.read();
        // Claims hang off the events that support them. Show them with their
        // entities and supersession links; entities themselves are not expanded.
        let mut claims: Vec<_> = ids
            .iter()
            .copied()
            .filter(|id| self.claims.contains_key(id))
            .collect();
        for &id in &ids {
            if self.memory.by_id.contains_key(&id) {
                read.visit_neighbors(
                    id,
                    Direction::Incoming,
                    EdgeFilter::default(),
                    |other, _| {
                        if self.claims.contains_key(&other) {
                            claims.push(other);
                        }
                    },
                )?;
            }
        }
        for claim in claims {
            ids.insert(claim);
            read.visit_neighbors(claim, Direction::Both, EdgeFilter::default(), |other, _| {
                if !self.memory.by_id.contains_key(&other) {
                    ids.insert(other);
                }
            })?;
        }
        let mut edges = HashMap::new();
        // Event and claim adjacency is small (scope membership, chronology,
        // evidence). Reading it from both ends avoids expanding every
        // high-degree scope or entity.
        for &id in &ids {
            if self.memory.by_id.contains_key(&id) || self.claims.contains_key(&id) {
                read.visit_neighbors(id,Direction::Both,EdgeFilter::default(),|other,edge_id|{
                    if ids.contains(&other)
                        && let Some(e)=read.edge(edge_id) { edges.insert(edge_id,json!({"id":e.id,"source":e.source,"target":e.target,"label":read.symbol(e.label).unwrap_or("Edge")})); }
                })?;
            }
        }
        let stats = read.stats();
        drop(read);
        let mut nodes: Vec<_> = ids
            .into_iter()
            .filter_map(|id| self.memory_node(id))
            .collect();
        nodes.sort_by_key(|n| n["id"].as_u64());
        let mut edges: Vec<_> = edges.into_values().collect();
        edges.sort_by_key(|e| e["id"].as_u64());
        let step = if focus.is_some() { 100 } else { 12 };
        let next = offset.saturating_add(step);
        let more =
            focus.is_none_or(|id| !self.memory.by_id.contains_key(&id)) && next < total_context;
        Ok(json!({
            "nodes": nodes,
            "edges": edges,
            "focus": focus,
            "offset": offset,
            "context_total": total_context,
            "next_offset": more.then_some(next),
            "stats": {
                "nodes": stats.nodes,
                "edges": stats.edges,
                "vectors": stats.indexed_vectors,
                "runs": self.memory.runs.len(),
            },
        }))
    }
    pub fn memory_element(&self, kind: &str, id: u64) -> Result<Value> {
        let summary = if kind == "node" {
            self.memory_node(id)
        } else {
            None
        };
        let read = self.db.read();
        let (properties, vector, mut result) = match kind {
            "node" => {
                let n = read.node(id).context("Node not found")?;
                (
                    n.properties.clone(),
                    read.node_vector_owned(id, 0)?,
                    summary.context("Node not found")?,
                )
            }
            "edge" => {
                let e = read.edge(id).context("Relationship not found")?;
                (
                    e.properties.clone(),
                    read.edge_vector_owned(id, 0)?,
                    json!({"id":id,"label":read.symbol(e.label),"source":e.source,"target":e.target,"vectors":e.vector_count}),
                )
            }
            _ => bail!("Unknown element kind"),
        };
        let mut values = serde_json::Map::new();
        for p in properties.iter() {
            let value = match &p.value {
                V::Null => Value::Null,
                V::Bool(v) => json!(v),
                V::Int(v) => json!(v),
                V::Float(v) => json!(v),
                V::String(v) => {
                    if read.symbol(p.key) == Some("event") {
                        serde_json::from_str(v).unwrap_or_else(|_| json!(v.to_string()))
                    } else {
                        json!(v.to_string())
                    }
                }
                V::Bytes(v) => json!({"bytes":v.len()}),
                V::Node(v) => json!({"node":v}),
                V::Edge(v) => json!({"edge":v}),
            };
            values.insert(read.symbol(p.key).unwrap_or("property").into(), value);
        }
        result["properties"] = json!(values);
        result["vector"] = json!(vector);
        if kind == "node" {
            let mut neighbors = Vec::new();
            let mut degree = 0;
            read.visit_neighbors(id,Direction::Both,EdgeFilter::default(),|other,edge|{
                degree+=1;
                if neighbors.len()<40 && let Some(e)=read.edge(edge) {neighbors.push(json!({"id":edge,"node":other,"label":read.symbol(e.label),"direction":if e.source==id {"out"}else{"in"}}));}
            })?;
            result["neighbors"] = json!(neighbors);
            result["degree"] = json!(degree);
        }
        Ok(result)
    }
    /// What consolidation reads from one turn: the user's message, the final
    /// assistant message and the latest tool receipts, with event IDs, clipped.
    pub fn turn_digest(&self, run: u64) -> Result<Value> {
        let events: Vec<_> = self
            .memory
            .runs
            .get(&run)
            .context("Run not found")?
            .iter()
            .map(|&i| &self.events[i])
            .collect();
        let user = events
            .first()
            .filter(|e| e.kind == "message.user")
            .context("Turn has no user message")?;
        let assistant = events.iter().rev().find(|e| e.kind == "message.assistant");
        let receipts: Vec<_> = events.iter().filter(|e| e.kind == "tool.result").collect();
        let skip = receipts.len().saturating_sub(24);
        Ok(json!({
            "user": {"id": user.id, "text": clip(&text_of(user), 4000)},
            "assistant": assistant.map(|e| json!({"id": e.id, "text": clip(&text_of(e), 4000)})),
            "receipts": receipts.into_iter().skip(skip).map(|e| json!({
                "id": e.id,
                "name": e.payload["name"],
                "ok": e.payload["result"]["ok"],
                "arguments": clip(&e.payload["arguments"].to_string(), 400),
                "result": clip(&e.payload["result"].to_string(), 800),
            })).collect::<Vec<_>>(),
        }))
    }
    pub fn memory_run(&self, id: u64, anchor: Option<u64>, offset: Option<usize>) -> Result<Value> {
        let positions = self.memory.runs.get(&id).context("Run not found")?;
        let first = &self.events[positions[0]];
        let visible: Vec<_> = positions
            .iter()
            .copied()
            .filter(|&i| !transport(&self.events[i].kind) || Some(self.events[i].id) == anchor)
            .collect();
        let start = offset.unwrap_or_else(|| {
            anchor
                .and_then(|a| visible.iter().position(|&i| self.events[i].id == a))
                .map(|i| i.saturating_sub(5))
                .unwrap_or(0)
        });
        let events: Vec<_> = visible
            .iter()
            .skip(start)
            .take(80)
            .map(|&i| {
                let mut e = self.events[i].clone();
                if let Some(p) = e.payload.as_object_mut() {
                    p.remove("bytes");
                }
                e
            })
            .collect();
        let scope = &self.memory.by_scope[&first.scope];
        let mut runs: Vec<_> = scope
            .iter()
            .filter_map(|&i| self.memory.run_for.get(&self.events[i].id).copied())
            .collect();
        runs.dedup();
        let index = runs.iter().position(|&r| r == id).unwrap_or(0);
        let status = if positions
            .iter()
            .any(|&i| self.events[i].kind == "agent.error")
        {
            "Failed"
        } else if positions
            .iter()
            .any(|&i| self.events[i].kind == "agent.stopped")
        {
            "Stopped"
        } else if positions
            .iter()
            .any(|&i| self.events[i].kind == "agent.finished")
        {
            "Complete"
        } else {
            "Recorded"
        };
        let next = start.saturating_add(80);
        Ok(json!({
            "id": id,
            "scope": first.scope,
            "name": self.scope_title(&first.scope),
            "prompt": clip(&text_of(first), 200),
            "time": first.time,
            "status": status,
            "events": events,
            "total": visible.len(),
            "offset": start,
            "next_offset": (next < visible.len()).then_some(next),
            "previous_offset": (start > 0).then_some(start.saturating_sub(80)),
            "previous_run": index.checked_sub(1).map(|i| runs[i]),
            "next_run": runs.get(index + 1),
        }))
    }
}
