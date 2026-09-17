// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::StoreError;
use serde_json::{Map, Value};
#[cfg(feature = "postgres")]
use sqlx::Row;

pub(crate) type RowData = Map<String, Value>;

pub(crate) enum Connection {
    Turso(turso::Connection),
    #[cfg(feature = "postgres")]
    Postgres(sqlx::PgConnection),
}
impl Connection {
    pub(crate) async fn rollback(&mut self) -> Result<(), StoreError> {
        // Turso rejects ROLLBACK if cancellation happened before BEGIN took effect.
        if let Self::Turso(connection) = self
            && connection.is_autocommit()?
        {
            return Ok(());
        }
        self.batch("ROLLBACK").await
    }
    pub(crate) async fn close(self) -> Result<(), StoreError> {
        match self {
            Self::Turso(connection) => drop(connection),
            #[cfg(feature = "postgres")]
            Self::Postgres(connection) => {
                sqlx::Connection::close(connection).await?;
            }
        }
        Ok(())
    }
    pub(crate) fn pg(&self) -> bool {
        match self {
            Self::Turso(_) => false,
            #[cfg(feature = "postgres")]
            Self::Postgres(_) => true,
        }
    }
    pub(crate) async fn batch(&mut self, sql: &str) -> Result<(), StoreError> {
        match self {
            Self::Turso(c) => c.execute_batch(sql).await?,
            #[cfg(feature = "postgres")]
            Self::Postgres(c) => {
                let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(c).await?;
            }
        }
        Ok(())
    }
    pub(crate) async fn execute(&mut self, sql: &str, args: &[Value]) -> Result<u64, StoreError> {
        match self {
            Self::Turso(c) => Ok(c.execute(sql, values(args)?).await?),
            #[cfg(feature = "postgres")]
            Self::Postgres(c) => {
                let sql = postgres_sql(sql);
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
                for arg in args {
                    query = bind(query, arg);
                }
                Ok(query.execute(c).await?.rows_affected())
            }
        }
    }
    pub(crate) async fn query_api(
        &mut self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<RowData>, StoreError> {
        let connection = match self {
            Self::Turso(connection) => connection,
            #[cfg(feature = "postgres")]
            Self::Postgres(_) => return Err(StoreError::Invalid("API pool read required".into())),
        };
        let names = connection.prepare(sql).await?.column_names();
        let fields = names
            .iter()
            .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(",");
        // Bound the result set to API_ROWS + 1 rows. The per-row byte budget is
        // enforced here in Rust (ApiBudget/check_api_json) rather than in SQL:
        // Turso 0.7.2's translator stack-overflows on a size expression with ten
        // or more + terms, and the wrapped SELECT * already materializes every
        // column in the inner subquery, so a SQL ceiling adds no memory safety.
        let sql = format!(
            "SELECT {fields} FROM ({sql}) api_result LIMIT {}",
            API_ROWS + 1
        );
        let mut rows = connection.query(&sql, values(args)?).await?;
        let mut budget = ApiBudget::default();
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_value(index)? {
                    turso::Value::Null => Value::Null,
                    turso::Value::Integer(value) => value.into(),
                    turso::Value::Real(value) => serde_json::json!(value),
                    turso::Value::Text(value) => value.into(),
                    turso::Value::Blob(_) => {
                        return Err(StoreError::Invalid("unexpected SQL blob".into()));
                    }
                };
                let value = if crate::store::kind(name) == "jsonb" {
                    if let Value::String(text) = &value {
                        parse_api_json(text)?
                    } else {
                        value
                    }
                } else {
                    value
                };
                let _ = object.insert(name.clone(), value);
            }
            budget.push(&object)?;
            out.push(object);
        }
        Ok(out)
    }
    pub(crate) async fn query(
        &mut self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<RowData>, StoreError> {
        match self {
            Self::Turso(c) => {
                let mut rows = c.query(sql, values(args)?).await?;
                let names = rows.column_names();
                let mut out = Vec::new();
                while let Some(row) = rows.next().await? {
                    let mut obj = Map::new();
                    for (i, name) in names.iter().enumerate() {
                        let _ = obj.insert(
                            name.clone(),
                            match row.get_value(i)? {
                                turso::Value::Null => Value::Null,
                                turso::Value::Integer(x) => x.into(),
                                turso::Value::Real(x) => serde_json::json!(x),
                                turso::Value::Text(x) => x.into(),
                                turso::Value::Blob(_) => {
                                    return Err(StoreError::Invalid("unexpected SQL blob".into()));
                                }
                            },
                        );
                    }
                    out.push(obj);
                }
                Ok(out)
            }
            #[cfg(feature = "postgres")]
            Self::Postgres(c) => {
                let sql = format!(
                    "SELECT to_jsonb(result) AS data FROM ({}) result",
                    postgres_sql(sql)
                );
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
                for arg in args {
                    query = bind(query, arg);
                }
                let rows = query.fetch_all(c).await?;
                let mut out = Vec::new();
                for row in rows {
                    let value: Value = row.try_get("data")?;
                    let Value::Object(obj) = value else {
                        return Err(StoreError::Invalid("invalid SQL row".into()));
                    };
                    out.push(obj);
                }
                Ok(out)
            }
        }
    }
}
/// Public projections bound rows and estimated owned JSON heap before collection.
pub(crate) const API_ROWS: usize = 16384;
pub(crate) const API_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub(crate) struct ApiBudget {
    rows: usize,
    bytes: usize,
}
impl ApiBudget {
    pub(crate) fn push(&mut self, row: &RowData) -> Result<(), StoreError> {
        let bytes = row
            .iter()
            .fold(size_of::<RowData>(), |total, (key, value)| {
                total
                    .saturating_add(key.capacity())
                    .saturating_add(96)
                    .saturating_add(value_bytes(value))
            });
        self.rows = self.rows.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.rows > API_ROWS || self.bytes > API_BYTES {
            return Err(StoreError::Capacity);
        }
        Ok(())
    }
}
/// Count JSON allocation pressure before constructing nested values. This
/// deliberately overestimates punctuation, keys and scalar nodes; quoted text
/// is charged twice to cover decoder scratch space and owned strings.
pub(crate) fn check_api_json(text: &str) -> Result<(), StoreError> {
    let mut bytes = text.len().saturating_mul(2);
    let mut quoted = false;
    let mut escaped = false;
    for byte in text.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
            bytes = bytes.saturating_add(96);
        } else if !byte.is_ascii_whitespace() {
            bytes = bytes.saturating_add(96);
        }
        if bytes > API_BYTES {
            return Err(StoreError::Capacity);
        }
    }
    Ok(())
}
pub(crate) fn parse_api_json(text: &str) -> Result<Value, StoreError> {
    check_api_json(text)?;
    Ok(serde_json::from_str(text)?)
}
fn value_bytes(value: &Value) -> usize {
    size_of::<Value>().saturating_add(match value {
        Value::Null | Value::Bool(_) => 0,
        Value::Number(number) => number.to_string().len(),
        Value::String(text) => text.capacity(),
        Value::Array(values) => values.iter().fold(0_usize, |total, value| {
            total.saturating_add(value_bytes(value))
        }),
        Value::Object(values) => values.iter().fold(0_usize, |total, (key, value)| {
            total
                .saturating_add(key.capacity())
                .saturating_add(96)
                .saturating_add(value_bytes(value))
        }),
    })
}
fn values(args: &[Value]) -> Result<Vec<turso::Value>, StoreError> {
    args.iter()
        .map(|x| {
            Ok(match x {
                Value::Null => turso::Value::Null,
                Value::Bool(v) => turso::Value::Integer(i64::from(*v)),
                Value::String(v) => turso::Value::Text(v.clone()),
                Value::Number(v) => {
                    if let Some(i) = v.as_i64() {
                        turso::Value::Integer(i)
                    } else if v.is_u64() {
                        turso::Value::Text(v.to_string())
                    } else {
                        turso::Value::Real(
                            v.as_f64()
                                .ok_or_else(|| StoreError::Invalid("non-finite number".into()))?,
                        )
                    }
                }
                Value::Array(_) | Value::Object(_) => turso::Value::Text(serde_json::to_string(x)?),
            })
        })
        .collect()
}
#[cfg(feature = "postgres")]
fn bind<'q>(
    q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    v: &Value,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    // Every placeholder has an explicit SQL cast. Text binding avoids precision loss.
    q.bind(match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Array(_) | Value::Object(_) => Some(v.to_string()),
    })
}
#[cfg(feature = "postgres")]
pub(crate) fn postgres_sql(sql: &str) -> String {
    let mut out = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '?' && chars.peek().is_some_and(char::is_ascii_digit) {
            out.push('$');
            while chars.peek().is_some_and(char::is_ascii_digit) {
                if let Some(d) = chars.next() {
                    out.push(d);
                }
            }
            out.push_str("::text");
        } else {
            out.push(c);
        }
    }
    out
}
/// Explicit casts keep Postgres text binds and Turso decimal TEXT columns exact.
pub(crate) fn parameter(index: usize, kind: &str, pg: bool) -> String {
    if pg || kind == "integer" || kind == "bigint" || kind == "double precision" {
        format!("CAST(?{index} AS {kind})")
    } else {
        format!("?{index}")
    }
}
pub(crate) fn decimal_order(column: &str) -> String {
    format!("length(CAST({column} AS TEXT)), CAST({column} AS TEXT)")
}
pub(crate) fn decimal_gt(left: &str, right: &str) -> String {
    format!(
        "(length(CAST({left} AS TEXT)) > length(CAST({right} AS TEXT)) OR (length(CAST({left} AS TEXT)) = length(CAST({right} AS TEXT)) AND CAST({left} AS TEXT) > CAST({right} AS TEXT)))"
    )
}
pub(crate) fn text(row: &RowData, key: &str) -> Result<String, StoreError> {
    let v = row
        .get(key)
        .ok_or_else(|| StoreError::Invalid(format!("missing column {key}")))?;
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null | Value::Array(_) | Value::Object(_) => {
            Err(StoreError::Invalid(format!("non-scalar column {key}")))
        }
    }
}
pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn epoch(iso: &str) -> Result<i64, StoreError> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|t| t.timestamp())
        .map_err(|e| StoreError::Invalid(e.to_string()))
}
pub(crate) fn iso(seconds: u64) -> Result<String, StoreError> {
    let seconds = i64::try_from(seconds).map_err(|e| StoreError::Invalid(e.to_string()))?;
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|t| {
            t.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .ok_or_else(|| StoreError::Invalid("timestamp out of range".into()))
}

pub(crate) fn canonical_timestamp(timestamp: &str) -> Result<String, StoreError> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|t| {
            t.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .map_err(|e| StoreError::Invalid(e.to_string()))
}
