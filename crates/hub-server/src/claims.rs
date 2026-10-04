//! Distilled memory: claims written after a turn and recalled before the next.
use crate::memory::{clip, text_of};
use crate::store::Store;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};
use vecgra::{Direction, EdgeFilter, ElementRef, Property, ReadGuard, Value as V, VectorTarget};

/// Memory recalls on vector similarity alone at this cosine score. Measured
/// with Gemini Embedding 2: related query/claim pairs score about 0.72,
/// unrelated ones 0.49 to 0.63.
pub const MIN_SIMILARITY: f32 = 0.65;
/// Memory recalls on words alone when it holds this share of the query's
/// rarity-weighted words.
pub const MIN_OVERLAP: f32 = 0.35;

#[derive(Clone, Debug)]
pub struct Claim {
    pub text: String,
    pub state: String,
    pub created_at: String,
    pub scope: String,
    pub source: String,
    pub about: Vec<String>,
    pub evidence: Vec<u64>,
}

/// One extracted claim, already validated by agent/consolidate.py.
#[derive(Deserialize)]
pub struct NewClaim {
    pub text: String,
    pub about: Vec<String>,
    pub supersedes: Vec<u64>,
    pub evidence: Vec<u64>,
}

pub(crate) fn string(read: &ReadGuard, properties: &[Property], key: &str) -> String {
    match read.property(properties, key) {
        Some(V::String(value)) => value.to_string(),
        _ => String::new(),
    }
}

impl Claim {
    pub(crate) fn read(read: &ReadGuard, properties: &[Property]) -> Self {
        Self {
            text: string(read, properties, "text"),
            state: string(read, properties, "state"),
            created_at: string(read, properties, "created_at"),
            scope: string(read, properties, "scope"),
            source: string(read, properties, "source"),
            about: Vec::new(),
            evidence: Vec::new(),
        }
    }
}

/// A node's properties and vectors, ready for `update_node`.
type Restated = (Vec<(String, V)>, Vec<Vec<f32>>);

fn score(value: f32) -> f64 {
    (value as f64 * 100.0).round() / 100.0
}

impl Store {
    /// A claim node's properties with a new state. Its vector is carried over.
    fn restated(&self, id: u64, state: &str) -> Result<Restated> {
        let read = self.db.read();
        let node = read.node(id).context("Claim not found")?;
        let properties = node
            .properties
            .iter()
            .map(|p| {
                let key = read.symbol(p.key).unwrap().to_owned();
                let value = if key == "state" {
                    V::String(Arc::from(state))
                } else {
                    p.value.clone()
                };
                (key, value)
            })
            .collect();
        Ok((
            properties,
            read.node_vector_owned(id, 0)?.into_iter().collect(),
        ))
    }

    /// Write consolidated claims with their entities, evidence and supersessions
    /// in one transaction. Returns the `memory.written` claim payloads.
    pub fn write_claims(
        &mut self,
        scope: &str,
        source: &str,
        claims: Vec<NewClaim>,
    ) -> Result<Value> {
        let superseded: BTreeSet<u64> = claims.iter().flat_map(|c| c.supersedes.clone()).collect();
        for id in &superseded {
            ensure!(
                self.claims.get(id).is_some_and(|c| c.state == "active"),
                "Claim {id} is no longer active"
            );
        }
        for id in claims.iter().flat_map(|c| &c.evidence) {
            ensure!(self.memory.by_id.contains_key(id), "Event {id} not found");
        }
        let replaced = superseded
            .iter()
            .map(|&id| Ok((id, self.restated(id, "superseded")?)))
            .collect::<Result<Vec<_>>>()?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut created = HashMap::new();
        let mut written = Vec::new();
        let mut tx = self.db.transaction();
        for claim in claims {
            let id = tx.create_node(
                "Claim",
                [
                    ("text", V::String(Arc::from(claim.text.as_str()))),
                    ("state", V::String(Arc::from("active"))),
                    ("created_at", V::String(Arc::from(now.as_str()))),
                    ("scope", V::String(Arc::from(scope))),
                    ("source", V::String(Arc::from(source))),
                ],
                &[],
            );
            let mut about: Vec<String> = claim
                .about
                .iter()
                .map(|a| a.trim().to_lowercase())
                .collect();
            about.sort();
            about.dedup();
            for name in &about {
                let entity = match self.entities.get(name).or(created.get(name)) {
                    Some(&entity) => entity,
                    None => {
                        let entity = tx.create_node(
                            "Entity",
                            [("name", V::String(Arc::from(name.as_str())))],
                            &[],
                        );
                        created.insert(name.clone(), entity);
                        entity
                    }
                };
                tx.create_edge(id, entity, "ABOUT", std::iter::empty::<(&str, V)>(), &[]);
            }
            for &event in &claim.evidence {
                tx.create_edge(
                    id,
                    event,
                    "SUPPORTED_BY",
                    std::iter::empty::<(&str, V)>(),
                    &[],
                );
            }
            for &old in &claim.supersedes {
                tx.create_edge(id, old, "SUPERSEDES", std::iter::empty::<(&str, V)>(), &[]);
            }
            written.push((id, claim, about));
        }
        for (id, (properties, vectors)) in replaced {
            tx.update_node(id, "Claim", properties, &vectors)?;
        }
        tx.commit()?;
        self.entities.extend(created);
        for id in &superseded {
            self.claims.get_mut(id).unwrap().state = "superseded".into();
        }
        let mut payload = Vec::new();
        for (id, claim, about) in written {
            payload.push(json!({
                "id": id,
                "text": claim.text,
                "about": about,
                "supersedes": claim.supersedes.iter().map(|old| json!({"id":old,"text":self.claims[old].text})).collect::<Vec<_>>(),
            }));
            self.claims.insert(
                id,
                Claim {
                    text: claim.text,
                    state: "active".into(),
                    created_at: now.clone(),
                    scope: scope.into(),
                    source: source.into(),
                    about,
                    evidence: claim.evidence,
                },
            );
        }
        Ok(json!(payload))
    }

    /// Mark a claim wrong (retracted), or restore it to the state it had.
    pub fn mark_claim(&mut self, id: u64, wrong: bool) -> Result<Claim> {
        let current = self.claims.get(&id).context("Claim not found")?;
        let state = if wrong {
            ensure!(
                current.state != "retracted",
                "This claim is already marked wrong"
            );
            "retracted"
        } else {
            ensure!(
                current.state == "retracted",
                "Only a claim marked wrong can be restored"
            );
            let read = self.db.read();
            let superseded = read
                .neighbors(id, Direction::Incoming, EdgeFilter::default())?
                .iter()
                .any(|e| read.symbol(e.label) == Some("SUPERSEDES"));
            if superseded { "superseded" } else { "active" }
        };
        let (properties, vectors) = self.restated(id, state)?;
        let mut tx = self.db.transaction();
        tx.update_node(id, "Claim", properties, &vectors)?;
        tx.commit()?;
        let claim = self.claims.get_mut(&id).unwrap();
        claim.state = state.into();
        Ok(claim.clone())
    }

    /// Query words weighted by their rarity in the archive, with the event
    /// positions that contain each one.
    fn weighted_terms(&self, query: &str) -> Vec<(String, f32, Vec<usize>)> {
        let mut words: Vec<_> = query
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() >= 3)
            .map(str::to_owned)
            .collect();
        words.sort();
        words.dedup();
        let total = self.memory.len() as f32;
        words
            .into_iter()
            .map(|word| {
                let positions = self.memory.containing(&word);
                let weight = (1.0 + total / (1.0 + positions.len() as f32)).ln();
                (word, weight, positions)
            })
            .collect()
    }

    fn similar(
        &self,
        vector: Option<&[f32]>,
        label: &str,
        limit: usize,
    ) -> Result<HashMap<u64, f32>> {
        let read = self.db.read();
        let (Some(vector), Some(label)) = (vector, read.label_id(label)) else {
            return Ok(HashMap::new());
        };
        Ok(read
            .vector_search(vector, VectorTarget::Nodes, limit, Some(label))?
            .into_iter()
            .filter_map(|hit| match hit.element {
                ElementRef::Node(id) => Some((id, hit.score)),
                _ => None,
            })
            .collect())
    }

    /// Active claims relevant to `query`, best first, with their scores.
    pub fn relevant_claims(
        &self,
        query: &str,
        vector: Option<&[f32]>,
        limit: usize,
    ) -> Result<Vec<(u64, f32)>> {
        let terms = self.weighted_terms(query);
        let weight: f32 = terms.iter().map(|t| t.1).sum();
        let similar = self.similar(vector, "Claim", 32)?;
        let mut ranked: Vec<_> = self
            .claims
            .iter()
            .filter(|(_, c)| c.state == "active")
            .filter_map(|(&id, claim)| {
                let text = claim.text.to_lowercase();
                let overlap = if weight > 0.0 {
                    terms
                        .iter()
                        .filter(|t| text.contains(&t.0))
                        .map(|t| t.1)
                        .sum::<f32>()
                        / weight
                } else {
                    0.0
                };
                let similarity = similar.get(&id).copied().unwrap_or(0.0);
                (similarity >= MIN_SIMILARITY || overlap >= MIN_OVERLAP)
                    .then_some((id, similarity.max(overlap)))
            })
            .collect();
        ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
        ranked.truncate(limit);
        Ok(ranked)
    }

    /// The active claims a turn's consolidation may supersede: those recalled
    /// for it that are still active, and the most relevant ones now.
    pub fn supersedable(
        &self,
        query: &str,
        vector: Option<&[f32]>,
        recalled: &[u64],
    ) -> Result<Value> {
        let mut ids: Vec<_> = recalled
            .iter()
            .copied()
            .filter(|id| self.claims.get(id).is_some_and(|c| c.state == "active"))
            .chain(
                self.relevant_claims(query, vector, 8)?
                    .into_iter()
                    .map(|(id, _)| id),
            )
            .collect();
        ids.sort_unstable();
        ids.dedup();
        Ok(json!(
            ids.iter()
                .map(
                    |id| json!({"id":id,"text":self.claims[id].text,"about":self.claims[id].about})
                )
                .collect::<Vec<_>>()
        ))
    }

    /// Up to 8 active claims and 4 earlier messages relevant to `query`.
    /// Messages already in the chat's context (`scope`, ID at or after
    /// `window`) are skipped.
    pub fn recall(
        &self,
        query: &str,
        vector: Option<&[f32]>,
        scope: &str,
        window: u64,
    ) -> Result<Vec<Value>> {
        let mut items: Vec<_> = self
            .relevant_claims(query, vector, 8)?
            .into_iter()
            .map(|(id, value)| {
                let claim = &self.claims[&id];
                json!({"id":id,"kind":"claim","text":claim.text,"source":claim.source,"time":claim.created_at,"score":score(value)})
            })
            .collect();
        let terms = self.weighted_terms(query);
        let weight: f32 = terms.iter().map(|t| t.1).sum();
        let mut overlap: HashMap<usize, f32> = HashMap::new();
        for (_, w, positions) in &terms {
            for &i in positions {
                *overlap.entry(i).or_default() += w / weight;
            }
        }
        let similar = self.similar(vector, "Event", 64)?;
        let candidates: BTreeSet<usize> = overlap
            .keys()
            .copied()
            .chain(
                similar
                    .keys()
                    .filter_map(|id| self.memory.by_id.get(id).copied()),
            )
            .collect();
        let mut events: Vec<_> = candidates
            .into_iter()
            .filter_map(|i| {
                let e = &self.events[i];
                if !matches!(e.kind.as_str(), "message.user" | "message.assistant")
                    || (e.scope == scope && e.id >= window)
                {
                    return None;
                }
                let overlap = overlap.get(&i).copied().unwrap_or(0.0);
                let similarity = similar.get(&e.id).copied().unwrap_or(0.0);
                (similarity >= MIN_SIMILARITY || overlap >= MIN_OVERLAP)
                    .then_some((similarity.max(overlap), e))
            })
            .collect();
        events.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then(b.1.id.cmp(&a.1.id)));
        items.extend(events.into_iter().take(4).map(|(value, e)| {
            let source = if e.kind == "message.user" { "you".into() } else { self.scope_title(&e.scope) };
            json!({"id":e.id,"kind":"event","text":clip(&text_of(e),400),"source":source,"time":e.time,"score":score(value)})
        }));
        Ok(items)
    }
}
