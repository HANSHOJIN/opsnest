use regex::Regex;
use std::sync::OnceLock;

/// Redact before truncation or persistence; preserve whitespace and JSON quotes.
pub fn sanitize(text: &str) -> String {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", "[REDACTED_PRIVATE_KEY]"),
            (r"(?i)\bBearer[ \t]+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]"),
            (r#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*')"#, "$1\"[REDACTED]\""),
            (r#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*)([^"' \t\r\n,;}]+)"#, "$1[REDACTED]"),
            (r"\bsk-[A-Za-z0-9_-]{8,}", "[REDACTED]"),
        ].into_iter().map(|(pattern, replacement)| (Regex::new(pattern).unwrap(), replacement)).collect()
    });
    rules.iter().fold(text.to_owned(), |value, (pattern, replacement)| {
        pattern.replace_all(&value, *replacement).into_owned()
    })
}

/// PTY packets are arbitrary fragments, not secret boundaries. Persist only
/// complete sanitized lines; oversized lines are omitted until the next LF.
#[derive(Default)]
pub struct StreamRedactor {
    pending: String,
    private_key: bool,
    overflow: bool,
}

impl StreamRedactor {
    pub fn push(&mut self, text: &str) -> String {
        let mut output = String::new();
        for part in text.split_inclusive('\n') {
            if !self.overflow {
                self.pending.push_str(part);
                if self.pending.len() > 65536 {
                    self.pending.clear();
                    self.overflow = true;
                }
            }
            if !part.ends_with('\n') { continue; }
            if self.overflow {
                output.push_str("[oversized terminal line omitted]\n");
                self.overflow = false;
                continue;
            }
            let line = std::mem::take(&mut self.pending);
            if line.contains("-----BEGIN ") && line.contains("PRIVATE KEY-----") {
                self.private_key = true;
                output.push_str("[REDACTED_PRIVATE_KEY]\n");
            }
            if self.private_key {
                if line.contains("-----END ") && line.contains("PRIVATE KEY-----") {
                    self.private_key = false;
                }
            } else {
                output.push_str(&sanitize(&line));
            }
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redact_headers_json_and_multiline_keys() {
        for input in [
            "Authorization: Bearer dummySensitiveToken",
            r#"{"apiKey": "dummySensitiveToken"}"#,
            "password = 'dummySensitiveToken'",
            "-----BEGIN OPENSSH PRIVATE KEY-----\ndummySensitiveToken\n-----END OPENSSH PRIVATE KEY-----",
        ] {
            assert!(!sanitize(input).contains("dummySensitiveToken"));
        }
    }
    #[test]
    fn every_packet_boundary_is_safe() {
        let input = "Authorization: Bearer dummySensitiveToken\n{\"apiKey\":\"dummySensitiveToken\"}\n-----BEGIN OPENSSH PRIVATE KEY-----\ndummySensitiveToken\n-----END OPENSSH PRIVATE KEY-----\nnormal output\n";
        for split in 0..=input.len() {
            let mut stream = StreamRedactor::default();
            let result = stream.push(&input[..split]) + &stream.push(&input[split..]);
            assert!(!result.contains("dummySensitiveToken"), "split {split}");
            assert!(result.ends_with("normal output\n"));
        }
    }
}
