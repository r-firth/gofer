use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use vecgra::{
    Database, DatabaseOptions, Direction, EdgeFilter, ElementRef, Value as V, VectorTarget,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: u64,
    pub kind: String,
    pub scope: String,
    pub time: String,
    pub payload: Value,
}

pub struct Store {
    pub artifacts: crate::artifacts::Artifacts,
    pub(crate) db: Database,
    pub(crate) events: Vec<Event>,
    pub(crate) scopes: HashMap<String, u64>,
    pub(crate) memory: crate::memory::MemoryIndex,
    pub(crate) claims: BTreeMap<u64, crate::claims::Claim>,
    pub(crate) entities: HashMap<String, u64>,
    last: HashMap<String, u64>,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
        let db = if path.exists() {
            Database::open(path)?
        } else {
            Database::create(path, DatabaseOptions::new(crate::embeddings::DIMENSIONS))?
        };
        // No user data is written before permissions are tightened. This also
        // protects archives created by versions that inherited the host umask.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let mut events = Vec::new();
        let artifacts = crate::artifacts::Artifacts::new(path.with_file_name("artifacts"))?;
        let mut scopes = HashMap::new();
        let mut last = HashMap::new();
        let mut claims = BTreeMap::new();
        let mut entities = HashMap::new();
        {
            let read = db.read();
            let mut names = HashMap::new();
            for id in read.node_ids() {
                let node = read.node(id).unwrap();
                match read.symbol(node.label) {
                    Some("Claim") => {
                        claims.insert(id, crate::claims::Claim::read(&read, &node.properties));
                    }
                    Some("Entity") => {
                        let name = crate::claims::string(&read, &node.properties, "name");
                        names.insert(id, name.clone());
                        entities.insert(name, id);
                    }
                    _ => {}
                }
                for p in node.properties.iter() {
                    if let V::String(s) = &p.value {
                        match read.symbol(p.key) {
                            Some("event") => {
                                let mut event: Event = serde_json::from_str(s)?;
                                event.id = id;
                                last.insert(event.scope.clone(), id);
                                events.push(event);
                            }
                            Some("scope_id") => {
                                scopes.insert(s.to_string(), id);
                            }
                            _ => {}
                        }
                    }
                }
            }
            for (&id, claim) in claims.iter_mut() {
                for edge in read.neighbors(id, Direction::Outgoing, EdgeFilter::default())? {
                    match read.symbol(edge.label) {
                        Some("ABOUT") => claim.about.push(names[&edge.target].clone()),
                        Some("SUPPORTED_BY") => claim.evidence.push(edge.target),
                        _ => {}
                    }
                }
            }
        }
        events.sort_by_key(|e| e.id);
        // Upgrade older native image receipts once. The image bytes are copied
        // before replacing embedded base64 with searchable attachment metadata.
        for event in &mut events {
            if event.kind != "tool.result" {
                continue;
            }
            let original = event.payload.clone();
            artifacts.normalize(&mut event.payload);
            if event.payload != original {
                let mut tx = db.transaction();
                tx.update_node(
                    event.id,
                    "Event",
                    [
                        ("event", V::String(Arc::from(serde_json::to_string(event)?))),
                        ("kind", V::String(Arc::from(event.kind.as_str()))),
                    ],
                    &[],
                )?;
                tx.commit()?;
            }
        }
        for event in &events {
            last.insert(event.scope.clone(), event.id);
        }
        let mut memory = crate::memory::MemoryIndex::default();
        for (i, event) in events.iter().enumerate() {
            memory.add(event, i);
        }
        Ok(Self {
            artifacts,
            memory,
            claims,
            entities,
            db,
            events,
            scopes,
            last,
        })
    }
    pub fn append(&mut self, kind: &str, scope: &str, mut payload: Value) -> Result<Event> {
        if kind == "tool.result" {
            self.artifacts.normalize(&mut payload);
        }
        let mut event = Event {
            id: 0,
            kind: kind.into(),
            scope: scope.into(),
            time: chrono::Utc::now().to_rfc3339(),
            payload,
        };
        let mut tx = self.db.transaction();
        let scope_node = self.scopes.get(scope).copied().unwrap_or_else(|| {
            tx.create_node("Scope", [("scope_id", V::String(Arc::from(scope)))], &[])
        });
        let text = serde_json::to_string(&event)?;
        let id = tx.create_node(
            "Event",
            [
                ("event", V::String(Arc::from(text))),
                ("kind", V::String(Arc::from(kind))),
            ],
            &[],
        );
        tx.create_edge(
            scope_node,
            id,
            "HAS_EVENT",
            std::iter::empty::<(&str, V)>(),
            &[],
        );
        if let Some(previous) = self.last.get(scope) {
            tx.create_edge(*previous, id, "NEXT", std::iter::empty::<(&str, V)>(), &[]);
        }
        tx.commit()?;
        event.id = id;
        self.scopes.insert(scope.into(), scope_node);
        self.last.insert(scope.into(), id);
        self.memory.add(&event, self.events.len());
        self.events.push(event.clone());
        Ok(event)
    }
    pub fn events(&self) -> Vec<Event> {
        self.events.clone()
    }
    pub fn metadata(&self) -> Vec<Event> {
        self.events
            .iter()
            .filter(|e| e.kind != "terminal.output")
            .cloned()
            .collect()
    }
    pub fn event_count(&self) -> usize {
        self.events.len()
    }
    pub fn archive_offset(&self, scope: &str) -> u64 {
        self.events
            .iter()
            .rev()
            .find(|e| e.scope == scope && e.kind == "terminal.output" && e.payload["end"].is_u64())
            .and_then(|e| e.payload["end"].as_u64())
            .unwrap_or(0)
    }
    pub fn has_terminal_output(&self, scope: &str) -> bool {
        self.events
            .iter()
            .any(|e| e.scope == scope && e.kind == "terminal.output")
    }
    /// Node IDs and document texts still waiting for a vector. Claims are few
    /// and recalled on every turn, so they are indexed before the archive.
    pub fn pending_embeddings(&self, limit: usize) -> Vec<(u64, String)> {
        let read = self.db.read();
        let unindexed = |id: u64| read.node(id).is_some_and(|n| n.vector_count == 0);
        let claims = self
            .claims
            .iter()
            .filter(|(id, _)| unindexed(**id))
            .map(|(&id, claim)| (id, claim.text.clone()));
        let events = self
            .events
            .iter()
            .filter(|e| {
                (matches!(
                    e.kind.as_str(),
                    "message.user"
                        | "message.assistant"
                        | "tool.result"
                        | "session.created"
                        | "device.saved"
                ) || (e.kind == "terminal.output"
                    && e.payload["text"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty())))
                    && unindexed(e.id)
            })
            .map(|e| {
                let text = e.payload["text"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| e.payload.to_string());
                (
                    e.id,
                    format!("{} {text}", e.kind).chars().take(6000).collect(),
                )
            });
        claims.chain(events).take(limit).collect()
    }
    /// Switch model identity and remove incompatible vectors durably. A new
    /// dimension rebuilds the file with every node ID preserved. Events, edges,
    /// properties and attachments stay put. Returns the backup of old vectors.
    pub fn prepare_embeddings(
        &mut self,
        profile: &str,
        dimensions: usize,
    ) -> Result<Option<PathBuf>> {
        let rebuild = self.db.vector_dimension() != dimensions;
        let read = self.db.read();
        let marker = read.node_ids().into_iter().find_map(|id| {
            let node = read.node(id)?;
            (read.symbol(node.label) == Some("EmbeddingConfig")).then(|| {
                let current = node.properties.iter().find_map(|p| {
                    if read.symbol(p.key) == Some("profile")
                        && let V::String(value) = &p.value
                    {
                        return Some(value.to_string());
                    }
                    None
                });
                (id, current)
            })
        });
        if !rebuild && marker.as_ref().and_then(|(_, p)| p.as_deref()) == Some(profile) {
            return Ok(None);
        }
        let nodes = read
            .node_ids()
            .into_iter()
            .filter_map(|id| {
                let n = read.node(id)?;
                (n.vector_count > 0).then(|| {
                    (
                        id,
                        read.symbol(n.label).unwrap().to_owned(),
                        n.properties
                            .iter()
                            .map(|p| (read.symbol(p.key).unwrap().to_owned(), p.value.clone()))
                            .collect::<Vec<_>>(),
                    )
                })
            })
            .collect::<Vec<_>>();
        let edges = read
            .edge_ids()
            .into_iter()
            .filter_map(|id| {
                let e = read.edge(id)?;
                (e.vector_count > 0).then(|| {
                    (
                        id,
                        e.source,
                        e.target,
                        read.symbol(e.label).unwrap().to_owned(),
                        e.properties
                            .iter()
                            .map(|p| (read.symbol(p.key).unwrap().to_owned(), p.value.clone()))
                            .collect::<Vec<_>>(),
                    )
                })
            })
            .collect::<Vec<_>>();
        drop(read);
        let path = self.db.path().to_owned();
        // Vecgra creates files with the host umask. Write inside a private
        // temporary directory, then publish already-protected files.
        let staging = tempfile::tempdir_in(path.parent().unwrap())?;
        let backup = if !nodes.is_empty() || !edges.is_empty() {
            let backup = path.with_file_name(format!(
                "{}.pre-embedding-{}.vg",
                path.file_name().unwrap().to_string_lossy(),
                uuid::Uuid::new_v4()
            ));
            let staged = staging.path().join("memory.vg");
            self.db.compact_to(&staged, self.db.vector_encoding())?;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))?;
            std::fs::rename(staged, &backup)?;
            Some(backup)
        } else {
            None
        };
        let rebuilt = if rebuild {
            Some(self.copy_without_vectors(&staging.path().join("rebuilt.vg"), dimensions)?)
        } else {
            None
        };
        let db = rebuilt.as_ref().unwrap_or(&self.db);
        let mut tx = db.transaction();
        if rebuilt.is_none() {
            for (id, label, props) in nodes {
                tx.update_node(id, label, props, &[])?;
            }
            for (id, source, target, label, props) in edges {
                tx.update_edge(id, source, target, label, props, &[])?;
            }
        }
        let props = [("profile", V::String(Arc::from(profile)))];
        if let Some((id, _)) = marker {
            tx.update_node(id, "EmbeddingConfig", props, &[])?;
        } else {
            tx.create_node("EmbeddingConfig", props, &[]);
        }
        tx.commit()?;
        if let Some(db) = rebuilt {
            // The complete new file atomically replaces the old one.
            let staged = db.path().to_owned();
            drop(db);
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))?;
            std::fs::rename(staged, &path)?;
            self.db = Database::open(&path)?;
        }
        Ok(backup)
    }
    /// Copy every node and edge, without vectors, into a new file. IDs are
    /// allocated in order, so placeholders fill gaps left by uncommitted
    /// writes and are deleted afterwards: every node keeps its ID.
    fn copy_without_vectors(&self, path: &Path, dimensions: usize) -> Result<Database> {
        let target = Database::create(path, DatabaseOptions::new(dimensions))?;
        let read = self.db.read();
        let properties = |properties: &[vecgra::Property]| {
            properties
                .iter()
                .map(|p| (read.symbol(p.key).unwrap().to_owned(), p.value.clone()))
                .collect::<Vec<_>>()
        };
        let mut nodes = read.node_ids();
        nodes.sort_unstable();
        let mut gaps = Vec::new();
        let mut next = 0;
        for chunk in nodes.chunks(4096) {
            let mut tx = target.transaction();
            for &id in chunk {
                while next < id {
                    gaps.push(tx.create_node("Gap", std::iter::empty::<(&str, V)>(), &[]));
                    next += 1;
                }
                let node = read.node(id).unwrap();
                tx.create_node(
                    read.symbol(node.label).unwrap(),
                    properties(&node.properties),
                    &[],
                );
                next = id + 1;
            }
            tx.commit()?;
        }
        let mut edges = read.edge_ids();
        edges.sort_unstable();
        for chunk in edges.chunks(4096) {
            let mut tx = target.transaction();
            for &id in chunk {
                let edge = read.edge(id).unwrap();
                tx.create_edge(
                    edge.source,
                    edge.target,
                    read.symbol(edge.label).unwrap(),
                    properties(&edge.properties),
                    &[],
                );
            }
            tx.commit()?;
        }
        let mut tx = target.transaction();
        for id in gaps {
            tx.delete_node(id, false);
        }
        tx.commit()?;
        Ok(target)
    }
    pub fn embed(&self, id: u64, vector: Vec<f32>) -> Result<()> {
        self.embed_batch(vec![(id, vector)])
    }
    pub fn embed_batch(&self, vectors: Vec<(u64, Vec<f32>)>) -> Result<()> {
        let mut tx = self.db.transaction();
        for (id, vector) in vectors {
            let (label, properties) = {
                let r = self.db.read();
                let n = r.node(id).ok_or_else(|| anyhow::anyhow!("node missing"))?;
                (
                    r.symbol(n.label).unwrap().to_owned(),
                    n.properties
                        .iter()
                        .map(|p| (r.symbol(p.key).unwrap().to_owned(), p.value.clone()))
                        .collect::<Vec<_>>(),
                )
            };
            tx.update_node(id, label, properties, &[vector])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn search(&self, query: &str, vector: Option<&[f32]>) -> Result<Vec<Event>> {
        let mut ranked: HashMap<u64, f32> = HashMap::new();
        if let Some(v) = vector {
            for hit in self
                .db
                .read()
                .vector_search(v, VectorTarget::Nodes, 24, None)?
            {
                if let ElementRef::Node(id) = hit.element {
                    ranked.insert(id, hit.score);
                }
            }
        }
        let query = query.to_lowercase();
        for event in self.events.iter() {
            // Keep transport chunks for replay; search the canonical answer.
            if matches!(event.kind.as_str(), "message.started" | "message.delta") {
                continue;
            }
            if (if event.kind == "terminal.output" {
                event.payload["text"].as_str().unwrap_or("").to_owned()
            } else {
                event.payload.to_string()
            })
            .to_lowercase()
            .contains(&query)
            {
                *ranked.entry(event.id).or_default() += 1.0;
            }
        }
        let mut matches: Vec<_> = self
            .events
            .iter()
            .filter_map(|e| ranked.get(&e.id).map(|s| (*s, e.clone())))
            .collect();
        matches.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(matches
            .into_iter()
            .take(30)
            .map(|(_, mut e)| {
                if let Some(payload) = e.payload.as_object_mut() {
                    payload.remove("bytes");
                }
                e
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_commit_does_not_leave_an_uncommitted_scope_in_memory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("memory.vg");
        let mut store = Store::open(&path).unwrap();
        // A read-only handle gives a deterministic commit failure without
        // damaging a file or depending on the host's permission model.
        store.db = Database::open_read_only(&path).unwrap();
        assert!(
            store
                .append("message.user", "chat", json!({"text":"retry me"}))
                .is_err()
        );
        store.db = Database::open(&path).unwrap();
        store
            .append("message.user", "chat", json!({"text":"retry succeeded"}))
            .unwrap();
        let graph = store.memory_graph(None, 0).unwrap();
        assert_eq!(graph["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
        drop(store);
        assert_eq!(Store::open(&path).unwrap().events().len(), 1);
    }

    #[test]
    fn a_new_dimension_rebuilds_memory_with_every_node_id_and_claim_intact() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.vg");
        let mut store = Store::open(&path).unwrap();
        let a = store
            .append("message.user", "chat", json!({"text":"I use uv"}))
            .unwrap();
        store
            .embed(a.id, vec![0.1; crate::embeddings::DIMENSIONS])
            .unwrap();
        // An uncommitted transaction leaves a gap in the node IDs.
        store
            .db
            .transaction()
            .create_node("Event", std::iter::empty::<(&str, V)>(), &[]);
        let b = store
            .append(
                "message.assistant",
                "chat",
                json!({"text":"Noted, uv it is"}),
            )
            .unwrap();
        assert_eq!(b.id, a.id + 2, "The fixture must contain an ID gap");
        let claims = serde_json::from_value(
            json!([{"text":"Ryan uses uv for Python.","about":["Ryan","uv"],"supersedes":[],"evidence":[a.id,b.id]}]),
        );
        let claim = store
            .write_claims("chat", "Thread", claims.unwrap())
            .unwrap()[0]["id"]
            .as_u64()
            .unwrap();
        let before = serde_json::to_value(store.events()).unwrap();
        let graph = store.memory_graph(Some(claim), 0).unwrap();
        let backup = store.prepare_embeddings("qwen-384", 384).unwrap();
        assert!(backup.is_some(), "Old vectors are kept in a backup");
        assert_eq!(serde_json::to_value(store.events()).unwrap(), before);
        let rebuilt = store.memory_graph(Some(claim), 0).unwrap();
        let ids = |g: &Value| {
            g["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n["id"].clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&rebuilt), ids(&graph));
        assert_eq!(rebuilt["edges"], graph["edges"]);
        assert!(
            store
                .embed(claim, vec![0.2; crate::embeddings::DIMENSIONS])
                .is_err()
        );
        store.embed(claim, vec![0.2; 384]).unwrap();
        assert_eq!(store.pending_embeddings(100).len(), 2);
        drop(store);
        let mut reopened = Store::open(&path).unwrap();
        assert!(
            reopened
                .prepare_embeddings("qwen-384", 384)
                .unwrap()
                .is_none()
        );
        assert_eq!(serde_json::to_value(reopened.events()).unwrap(), before);
        let node = reopened.memory_element("node", claim).unwrap();
        assert_eq!(node["state"], "active");
        assert_eq!(node["about"], json!(["ryan", "uv"]));
        assert_eq!(node["evidence"], json!([a.id, b.id]));
        assert_eq!(node["vector"].as_array().unwrap().len(), 384);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
