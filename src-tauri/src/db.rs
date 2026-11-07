use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;
use crate::secret;

const SCHEMA_VERSION: i64 = 3;

pub struct Db {
    conn: Mutex<Connection>,
}

fn tags_from_str(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

fn tags_to_str(tags: &[String]) -> String {
    tags.iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

fn host_from_row(row: &Row<'_>) -> rusqlite::Result<Host> {
    let tags: String = row.get("tags")?;
    let port: i64 = row.get("port")?;
    let keepalive: i64 = row.get("keepalive_secs")?;
    let password_enc: Option<String> = row.get("password_enc")?;
    Ok(Host {
        id: row.get("id")?,
        label: row.get("label")?,
        hostname: row.get("hostname")?,
        port: port.clamp(1, 65535) as u16,
        username: row.get("username")?,
        protocol: row
            .get::<_, Option<String>>("protocol")?
            .unwrap_or_else(|| "ssh".into()),
        os: row.get("os")?,
        auth_type: row.get("auth_type")?,
        has_password: password_enc.is_some(),
        key_id: row.get("key_id")?,
        group_id: row.get("group_id")?,
        tags: tags_from_str(&tags),
        color: row.get("color")?,
        favorite: row.get::<_, i64>("favorite")? != 0,
        startup_command: row.get("startup_command")?,
        keepalive_secs: keepalive.clamp(5, 300) as u32,
        auto_reconnect: row.get::<_, i64>("auto_reconnect")? != 0,
        created_at: row.get("created_at")?,
        last_used_at: row.get("last_used_at")?,
    })
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open database: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| e.to_string())?;

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version < SCHEMA_VERSION {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    color TEXT,
                    sort INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ssh_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    key_type TEXT NOT NULL,
                    public_key TEXT NOT NULL,
                    fingerprint TEXT NOT NULL DEFAULT '',
                    comment TEXT,
                    private_key_enc TEXT NOT NULL,
                    passphrase_enc TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS hosts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    label TEXT NOT NULL,
                    hostname TEXT NOT NULL,
                    port INTEGER NOT NULL DEFAULT 22,
                    username TEXT NOT NULL,
                    protocol TEXT NOT NULL DEFAULT 'ssh',
                    os TEXT,
                    auth_type TEXT NOT NULL DEFAULT 'password',
                    password_enc TEXT,
                    key_id INTEGER,
                    group_id INTEGER,
                    tags TEXT NOT NULL DEFAULT '',
                    color TEXT,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    startup_command TEXT,
                    keepalive_secs INTEGER NOT NULL DEFAULT 20,
                    auto_reconnect INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS snippets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    label TEXT NOT NULL,
                    command TEXT NOT NULL,
                    tags TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS known_hosts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    endpoint TEXT NOT NULL UNIQUE,
                    key_type TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    added_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS port_forwards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    host_id INTEGER NOT NULL,
                    label TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    listen_host TEXT NOT NULL DEFAULT '127.0.0.1',
                    listen_port INTEGER NOT NULL,
                    target_host TEXT,
                    target_port INTEGER,
                    auto_start INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts(group_id);
                CREATE INDEX IF NOT EXISTS idx_forwards_host ON port_forwards(host_id);
                "#,
            )
            .map_err(|e| format!("create schema: {e}"))?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| e.to_string())?;
        }
        if version > 0 && version < 2 {
            // Databases created before FTP hosts existed.
            let _ = conn.execute_batch(
                "ALTER TABLE hosts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'ssh';",
            );
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| e.to_string())?;
        }
        if version > 0 && version < 3 {
            // OS/distro is detected after the first successful SSH connection.
            let _ = conn.execute_batch("ALTER TABLE hosts ADD COLUMN os TEXT;");
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| e.to_string())?;
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

// ------------------------------- groups -------------------------------

impl Db {
    pub fn list_groups(&self) -> DbResult<Vec<Group>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT g.id, g.name, g.color, g.sort,
                        (SELECT COUNT(*) FROM hosts h WHERE h.group_id = g.id) AS host_count
                 FROM groups g ORDER BY g.sort ASC, g.name COLLATE NOCASE ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Group {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    sort: row.get(3)?,
                    host_count: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn save_group(&self, input: GroupInput) -> DbResult<Group> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("Group name is required".into());
        }
        let conn = self.conn.lock().unwrap();
        let id = match input.id {
            Some(id) => {
                conn.execute(
                    "UPDATE groups SET name = ?1, color = ?2, sort = COALESCE(?3, sort) WHERE id = ?4",
                    params![name, input.color, input.sort, id],
                )
                .map_err(|e| e.to_string())?;
                id
            }
            None => {
                let sort = input.sort.unwrap_or_else(|| {
                    conn.query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM groups", [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .unwrap_or(0)
                });
                conn.execute(
                    "INSERT INTO groups (name, color, sort, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![name, input.color, sort, now_ts()],
                )
                .map_err(|e| e.to_string())?;
                conn.last_insert_rowid()
            }
        };
        conn.query_row(
            "SELECT g.id, g.name, g.color, g.sort,
                    (SELECT COUNT(*) FROM hosts h WHERE h.group_id = g.id) AS host_count
             FROM groups g WHERE g.id = ?1",
            params![id],
            |row| {
                Ok(Group {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    sort: row.get(3)?,
                    host_count: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    pub fn delete_group(&self, id: i64) -> DbResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE hosts SET group_id = NULL WHERE group_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM groups WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
}

// -------------------------------- hosts --------------------------------

impl Db {
    pub fn list_hosts(&self) -> DbResult<Vec<Host>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT * FROM hosts
                 ORDER BY favorite DESC, label COLLATE NOCASE ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], host_from_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn get_host(&self, id: i64) -> DbResult<Host> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM hosts WHERE id = ?1",
            params![id],
            host_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Host not found".to_string())
    }

    pub fn resolve_auth(&self, host_id: i64) -> DbResult<ResolvedAuth> {
        let conn = self.conn.lock().unwrap();
        let (username, auth_type, password_enc, key_id): (
            String,
            String,
            Option<String>,
            Option<i64>,
        ) = conn
            .query_row(
                "SELECT username, auth_type, password_enc, key_id FROM hosts WHERE id = ?1",
                params![host_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Host not found".to_string())?;

        let password = match password_enc {
            Some(enc) if !enc.is_empty() => Some(secret::unseal_str(&enc)?),
            _ => None,
        };

        let (mut private_key, mut passphrase) = (None, None);
        if auth_type == "key" {
            if let Some(key_id) = key_id {
                let row: Option<(String, Option<String>)> = conn
                    .query_row(
                        "SELECT private_key_enc, passphrase_enc FROM ssh_keys WHERE id = ?1",
                        params![key_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let row = row.ok_or_else(|| "Selected SSH key no longer exists".to_string())?;
                private_key = Some(secret::unseal_str(&row.0)?);
                if let Some(enc) = row.1.filter(|p| !p.is_empty()) {
                    passphrase = Some(secret::unseal_str(&enc)?);
                }
            } else {
                return Err("This host uses SSH key authentication but no key is selected".into());
            }
        }

        Ok(ResolvedAuth {
            username,
            password,
            private_key,
            passphrase,
        })
    }

    pub fn save_host(&self, input: HostInput) -> DbResult<Host> {
        let label = if input.label.trim().is_empty() {
            input.hostname.trim().to_string()
        } else {
            input.label.trim().to_string()
        };
        let hostname = input.hostname.trim();
        if hostname.is_empty() {
            return Err("Hostname is required".into());
        }
        if input.username.trim().is_empty() {
            return Err("Username is required".into());
        }
        let protocol = match input.protocol.as_deref() {
            Some("ftp") => "ftp",
            _ => "ssh",
        };
        let auth_type = if protocol == "ssh" && input.auth_type == "key" {
            "key"
        } else {
            "password"
        };
        let tags = tags_to_str(input.tags.as_deref().unwrap_or(&[]));

        let password_enc = match &input.password {
            None => None, // keep existing
            Some(pw) if pw.is_empty() => Some(String::new()),
            Some(pw) => Some(secret::seal_str(pw)?),
        };

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let id = match input.id {
            Some(id) => {
                let existing: Option<Option<String>> = tx
                    .query_row(
                        "SELECT password_enc FROM hosts WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let existing = existing.ok_or_else(|| "Host not found".to_string())?;
                let final_enc = password_enc.unwrap_or_else(|| existing.unwrap_or_default());
                tx.execute(
                    "UPDATE hosts SET label=?1, hostname=?2, port=?3, username=?4,
                        protocol=?5,
                        os=CASE WHEN hostname=?2 AND port=?3 AND username=?4 AND protocol=?5
                                THEN os ELSE NULL END,
                        auth_type=?6, key_id=?7, group_id=?8, tags=?9, color=?10,
                        startup_command=?11, keepalive_secs=?12, auto_reconnect=?13,
                        password_enc=NULLIF(?14, '')
                     WHERE id=?15",
                    params![
                        label,
                        hostname,
                        input.port.max(1),
                        input.username.trim(),
                        protocol,
                        auth_type,
                        if protocol == "ssh" {
                            input.key_id
                        } else {
                            None
                        },
                        input.group_id,
                        tags,
                        input.color,
                        input.startup_command.filter(|s| !s.trim().is_empty()),
                        input.keepalive_secs.unwrap_or(20).clamp(5, 300),
                        input.auto_reconnect.unwrap_or(true) as i64,
                        final_enc,
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO hosts (label, hostname, port, username, protocol, auth_type,
                        password_enc, key_id, group_id, tags, color, favorite, startup_command,
                        keepalive_secs, auto_reconnect, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,NULLIF(?7,''),?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                    params![
                        label,
                        hostname,
                        input.port.max(1),
                        input.username.trim(),
                        protocol,
                        auth_type,
                        password_enc.unwrap_or_default(),
                        if protocol == "ssh" {
                            input.key_id
                        } else {
                            None
                        },
                        input.group_id,
                        tags,
                        input.color,
                        input.favorite.unwrap_or(false) as i64,
                        input.startup_command.filter(|s| !s.trim().is_empty()),
                        input.keepalive_secs.unwrap_or(20).clamp(5, 300),
                        input.auto_reconnect.unwrap_or(true) as i64,
                        now_ts()
                    ],
                )
                .map_err(|e| e.to_string())?;
                tx.last_insert_rowid()
            }
        };
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        self.get_host(id)
    }

    pub fn set_host_favorite(&self, id: i64, favorite: bool) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE hosts SET favorite = ?1 WHERE id = ?2",
            params![favorite as i64, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_host_used(&self, id: i64) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE hosts SET last_used_at = ?1 WHERE id = ?2",
            params![now_ts(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_host_os(&self, id: i64, os: &str) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE hosts SET os = ?1 WHERE id = ?2",
            params![os.trim(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_host(&self, id: i64) -> DbResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM hosts WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM port_forwards WHERE host_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
}

// --------------------------------- keys ---------------------------------

impl Db {
    pub fn list_keys(&self) -> DbResult<Vec<KeyEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, key_type, public_key, fingerprint, comment,
                        (passphrase_enc IS NOT NULL AND passphrase_enc != '') AS has_pass, created_at
                 FROM ssh_keys ORDER BY name COLLATE NOCASE ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(KeyEntry {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    key_type: row.get(2)?,
                    public_key: row.get(3)?,
                    fingerprint: row.get(4)?,
                    comment: row.get(5)?,
                    has_passphrase: row.get::<_, i64>(6)? != 0,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_key(
        &self,
        name: &str,
        key_type: &str,
        public_key: &str,
        fingerprint: &str,
        private_key: &str,
        passphrase: Option<&str>,
        comment: Option<&str>,
    ) -> DbResult<KeyEntry> {
        let conn = self.conn.lock().unwrap();
        let private_enc = secret::seal_str(private_key)?;
        let pass_enc = match passphrase.filter(|p| !p.is_empty()) {
            Some(p) => Some(secret::seal_str(p)?),
            None => None,
        };
        conn.execute(
            "INSERT INTO ssh_keys (name, key_type, public_key, fingerprint, comment,
                private_key_enc, passphrase_enc, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                name.trim(),
                key_type,
                public_key.trim(),
                fingerprint,
                comment,
                private_enc,
                pass_enc,
                now_ts()
            ],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.list_keys()?
            .into_iter()
            .find(|k| k.id == id)
            .ok_or_else(|| "key not found after insert".to_string())
    }

    pub fn delete_key(&self, id: i64) -> DbResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE hosts SET key_id = NULL WHERE key_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM ssh_keys WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ------------------------------- snippets -------------------------------

impl Db {
    pub fn list_snippets(&self) -> DbResult<Vec<Snippet>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, label, command, tags, created_at FROM snippets ORDER BY label COLLATE NOCASE")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let tags: String = row.get(3)?;
                Ok(Snippet {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    command: row.get(2)?,
                    tags: tags_from_str(&tags),
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn save_snippet(&self, input: SnippetInput) -> DbResult<Snippet> {
        if input.label.trim().is_empty() {
            return Err("Snippet label is required".into());
        }
        if input.command.trim().is_empty() {
            return Err("Snippet command is required".into());
        }
        let tags = tags_to_str(input.tags.as_deref().unwrap_or(&[]));
        let conn = self.conn.lock().unwrap();
        let id = match input.id {
            Some(id) => {
                conn.execute(
                    "UPDATE snippets SET label=?1, command=?2, tags=?3 WHERE id=?4",
                    params![input.label.trim(), input.command, tags, id],
                )
                .map_err(|e| e.to_string())?;
                id
            }
            None => {
                conn.execute(
                    "INSERT INTO snippets (label, command, tags, created_at) VALUES (?1,?2,?3,?4)",
                    params![input.label.trim(), input.command, tags, now_ts()],
                )
                .map_err(|e| e.to_string())?;
                conn.last_insert_rowid()
            }
        };
        drop(conn);
        self.list_snippets()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| "snippet not found after save".to_string())
    }

    pub fn delete_snippet(&self, id: i64) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ------------------------------ known hosts ------------------------------

impl Db {
    pub fn known_hosts_map(&self) -> DbResult<HashMap<String, KnownHostEntry>> {
        let list = self.list_known_hosts()?;
        Ok(list.into_iter().map(|k| (k.endpoint.clone(), k)).collect())
    }

    pub fn list_known_hosts(&self) -> DbResult<Vec<KnownHostEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, endpoint, key_type, fingerprint, added_at FROM known_hosts ORDER BY endpoint")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(KnownHostEntry {
                    id: row.get(0)?,
                    endpoint: row.get(1)?,
                    key_type: row.get(2)?,
                    fingerprint: row.get(3)?,
                    added_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn upsert_known_host(
        &self,
        endpoint: &str,
        key_type: &str,
        fingerprint: &str,
    ) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO known_hosts (endpoint, key_type, fingerprint, added_at)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(endpoint) DO UPDATE SET key_type=excluded.key_type,
                fingerprint=excluded.fingerprint, added_at=excluded.added_at",
            params![endpoint, key_type, fingerprint, now_ts()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_known_host(&self, id: i64) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM known_hosts WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_known_host_endpoint(&self, endpoint: &str) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM known_hosts WHERE endpoint = ?1",
            params![endpoint],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ------------------------------ forwards ------------------------------

impl Db {
    pub fn list_forwards(&self) -> DbResult<Vec<PortForward>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM port_forwards ORDER BY label COLLATE NOCASE ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let listen_port: i64 = row.get("listen_port")?;
                let target_port: Option<i64> = row.get("target_port")?;
                Ok(PortForward {
                    id: row.get("id")?,
                    host_id: row.get("host_id")?,
                    label: row.get("label")?,
                    kind: row.get("kind")?,
                    listen_host: row.get("listen_host")?,
                    listen_port: listen_port.clamp(1, 65535) as u16,
                    target_host: row.get("target_host")?,
                    target_port: target_port.map(|p| p.clamp(1, 65535) as u16),
                    auto_start: row.get::<_, i64>("auto_start")? != 0,
                    created_at: row.get("created_at")?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn get_forward(&self, id: i64) -> DbResult<PortForward> {
        self.list_forwards()?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| "Port forward not found".to_string())
    }

    pub fn save_forward(&self, input: PortForwardInput) -> DbResult<PortForward> {
        let kind = match input.kind.as_str() {
            "local" | "remote" | "dynamic" => input.kind.as_str(),
            _ => return Err("Unknown forward type".into()),
        };
        if input.label.trim().is_empty() {
            return Err("Forward label is required".into());
        }
        if kind != "dynamic" {
            if input.target_host.as_deref().unwrap_or("").trim().is_empty()
                || input.target_port.unwrap_or(0) == 0
            {
                return Err("Target host and port are required".into());
            }
        }
        let conn = self.conn.lock().unwrap();
        let id = match input.id {
            Some(id) => {
                conn.execute(
                    "UPDATE port_forwards SET host_id=?1, label=?2, kind=?3, listen_host=?4,
                        listen_port=?5, target_host=?6, target_port=?7, auto_start=?8 WHERE id=?9",
                    params![
                        input.host_id,
                        input.label.trim(),
                        kind,
                        input.listen_host.trim(),
                        input.listen_port,
                        input.target_host.filter(|s| !s.trim().is_empty()),
                        input.target_port,
                        input.auto_start.unwrap_or(false) as i64,
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;
                id
            }
            None => {
                conn.execute(
                    "INSERT INTO port_forwards (host_id, label, kind, listen_host, listen_port,
                        target_host, target_port, auto_start, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        input.host_id,
                        input.label.trim(),
                        kind,
                        input.listen_host.trim(),
                        input.listen_port,
                        input.target_host.filter(|s| !s.trim().is_empty()),
                        input.target_port,
                        input.auto_start.unwrap_or(false) as i64,
                        now_ts()
                    ],
                )
                .map_err(|e| e.to_string())?;
                conn.last_insert_rowid()
            }
        };
        drop(conn);
        self.get_forward(id)
    }

    pub fn delete_forward(&self, id: i64) -> DbResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM port_forwards WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ------------------------------- settings -------------------------------

impl Db {
    pub fn get_settings(&self) -> DbResult<Settings> {
        let conn = self.conn.lock().unwrap();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        match raw {
            Some(json) => serde_json::from_str(&json).or_else(|_| Ok(Settings::default())),
            None => Ok(Settings::default()),
        }
    }

    pub fn save_settings(&self, settings: &Settings) -> DbResult<()> {
        let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('app', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
