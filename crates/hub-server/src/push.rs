//! Private Web Push subscriptions and a bounded, durable delivery queue.
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Write,
    path::{Path, PathBuf},
};
#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub client: String,
    pub chat: String,
    pub payload: Value,
    pub attempts: u32,
    pub next: i64,
    pub expires: i64,
}
#[derive(Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    keys: Value,
    #[serde(default)]
    clients: HashMap<String, Value>,
    #[serde(default)]
    jobs: VecDeque<Job>,
}
pub struct PushStore {
    path: PathBuf,
    data: Data,
    presence: HashMap<(String, String), (String, i64)>,
    failed: HashSet<String>,
}
pub fn valid_subscription(value: &Value) -> bool {
    if value.to_string().len() > 8192 {
        return false;
    }
    let Some(endpoint) = value["endpoint"].as_str().filter(|s| s.len() <= 4096) else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let service = host == "fcm.googleapis.com"
        || host == "updates.push.services.mozilla.com"
        || host.ends_with(".push.services.mozilla.com")
        || host.ends_with(".push.apple.com")
        || host.ends_with(".notify.windows.com");
    service
        && url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && [("p256dh", 65), ("auth", 16)].iter().all(|(key, length)| {
            value["keys"][key]
                .as_str()
                .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
                .is_some_and(|bytes| bytes.len() == *length && (*key != "p256dh" || bytes[0] == 4))
        })
}
impl PushStore {
    pub fn open(path: &Path) -> Result<Self> {
        if path.exists() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        let data = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("Invalid private push state")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Data::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            path: path.into(),
            data,
            presence: HashMap::new(),
            failed: HashSet::new(),
        })
    }
    fn save(&self) -> Result<()> {
        let parent = self.path.parent().context("Push state directory missing")?;
        std::fs::create_dir_all(parent)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(&serde_json::to_vec(&self.data)?)?;
        temp.as_file().sync_all()?;
        temp.persist(&self.path)?;
        Ok(())
    }
    pub fn keys(&self) -> Value {
        self.data.keys.clone()
    }
    pub fn set_keys(&mut self, keys: Value) -> Result<()> {
        if self.data.keys.is_null() {
            self.data.keys = keys;
            self.save()?
        }
        Ok(())
    }
    pub fn subscribed(&self, id: &str) -> bool {
        self.data.clients.contains_key(id)
    }
    pub fn subscription(&self, id: &str) -> Option<Value> {
        self.data.clients.get(id).cloned()
    }
    pub fn subscribe(&mut self, id: &str, subscription: Value) -> Result<()> {
        if id.is_empty() || id.len() > 80 || !valid_subscription(&subscription) {
            bail!("Invalid push subscription")
        };
        if self.data.clients.len() >= 64 && !self.subscribed(id) {
            bail!("Too many subscribed browsers")
        };
        self.data
            .clients
            .retain(|key, s| key == id || s["endpoint"] != subscription["endpoint"]);
        self.data.clients.insert(id.into(), subscription);
        self.save()
    }
    pub fn unsubscribe(&mut self, id: &str) -> Result<()> {
        self.data.clients.remove(id);
        self.data.jobs.retain(|j| j.client != id);
        self.save()
    }
    pub fn presence(&mut self, id: &str, tab: &str, chat: Option<&str>, now: i64) {
        self.presence.retain(|_, (_, time)| now - *time < 60);
        if self.subscribed(id) && tab.len() <= 80 {
            let key = (id.into(), tab.into());
            if let Some(chat) = chat {
                self.presence.insert(key, (chat.into(), now));
            } else {
                self.presence.remove(&key);
            }
        }
    }
    pub fn watching(&self, id: &str, chat: &str, now: i64) -> bool {
        self.presence
            .iter()
            .any(|((client, _), (scope, time))| client == id && scope == chat && now - *time < 60)
    }
    pub fn enqueue(
        &mut self,
        event: &str,
        chat: &str,
        payload: Value,
        now: i64,
        force: bool,
    ) -> Result<()> {
        for client in self.data.clients.keys() {
            let id = format!("{event}:{client}");
            if (!force && self.watching(client, chat, now))
                || self.data.jobs.iter().any(|j| j.id == id)
            {
                continue;
            };
            self.data.jobs.push_back(Job {
                id,
                client: client.clone(),
                chat: chat.into(),
                payload: payload.clone(),
                attempts: 0,
                next: now,
                expires: now + 3600,
            });
        }
        while self.data.jobs.len() > 256 {
            self.data.jobs.pop_front();
        }
        if !self.data.jobs.is_empty() {
            self.save()?
        }
        Ok(())
    }
    pub fn observe(&mut self, event: &crate::store::Event) -> Result<()> {
        if event.kind == "agent.started" {
            self.failed.remove(&event.scope);
        }
        let body = match event.kind.as_str() {
            "agent.error" => {
                if !self.failed.insert(event.scope.clone()) {
                    return Ok(());
                };
                "An agent needs attention."
            }
            "agent.finished" if !self.failed.contains(&event.scope) => "Your agent has finished.",
            "agent.requested" => "An agent is waiting for your input.",
            _ => return Ok(()),
        };
        self.enqueue(&event.id.to_string(),&event.scope,json!({"title":"Gofer","body":body,"chat_id":event.scope,"request_id":event.payload.get("request_id"),"tag":format!("session-{}",event.scope)}),chrono::Utc::now().timestamp(),false)
    }
    pub fn due(&self, now: i64) -> Option<Job> {
        self.data.jobs.iter().find(|j| j.next <= now).cloned()
    }
    pub fn delivered(&mut self, job: &Job, status: u16, now: i64) -> Result<()> {
        if status == 404 || status == 410 {
            self.data.clients.remove(&job.client);
            self.data.jobs.retain(|j| j.client != job.client);
        } else if status == 0
            || (200..300).contains(&status)
            || (400..500).contains(&status) && status != 408 && status != 429
            || job.attempts >= 5
            || job.expires <= now
        {
            self.data.jobs.retain(|j| j.id != job.id);
        } else if let Some(j) = self.data.jobs.iter_mut().find(|j| j.id == job.id) {
            j.attempts += 1;
            j.next = now + 30 * (1i64 << (j.attempts.min(5) - 1));
        }
        self.save()
    }
}
