use super::Document;

pub(super) const INPUT_VERSION: &str = "wiki-markdown-v1";

fn is_markdown(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("data:image/")
        || lower.contains(";base64,")
        || ["```html", "```css", "```scss", "```svg"]
            .iter()
            .any(|marker| lower.contains(marker))
    {
        return false;
    }
    for rest in lower.split('<').skip(1) {
        let rest = rest.trim_start_matches('/');
        let tag = rest
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .next()
            .unwrap_or_default();
        if rest.starts_with("!doctype")
            || matches!(
                tag,
                "html"
                    | "head"
                    | "body"
                    | "style"
                    | "script"
                    | "link"
                    | "meta"
                    | "img"
                    | "svg"
                    | "canvas"
                    | "iframe"
                    | "object"
                    | "embed"
                    | "div"
                    | "span"
                    | "section"
                    | "header"
                    | "footer"
                    | "main"
                    | "article"
                    | "picture"
                    | "table"
                    | "thead"
                    | "tbody"
                    | "tr"
                    | "td"
                    | "th"
                    | "p"
                    | "br"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "strong"
                    | "b"
                    | "em"
                    | "i"
                    | "ul"
                    | "ol"
                    | "li"
                    | "pre"
                    | "code"
            )
        {
            return false;
        }
    }
    !((lower.contains('{') && lower.contains('}'))
        && [
            "@font-face",
            "@media",
            "@keyframes",
            ":root",
            "font-family:",
            "background-color:",
        ]
        .iter()
        .any(|marker| lower.contains(marker)))
}

/// Filter individual source pages without changing the stored meeting or its citation identity.
pub(super) fn source(mut document: Document) -> Option<Document> {
    if !document.ai_context_enabled {
        return None;
    }
    if !is_markdown(&document.transcript) {
        document.transcript.clear();
        document.segments.clear();
    }
    if !is_markdown(&document.outline) {
        document.outline.clear();
    }
    document
        .conclusions
        .retain(|item| item["conclusionText"].as_str().is_some_and(is_markdown));
    document.todos.retain(|item| {
        item.get("title")
            .or_else(|| item.get("todoContent"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| !text.trim().is_empty() && is_markdown(text))
    });
    (!document.text().trim().is_empty()).then_some(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_rendered_pages_and_encoded_images_but_keeps_markdown_evidence() {
        let original = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            revision: "original-revision".into(),
            ai_context_enabled: true,
            transcript: "Friday remains a proposal.".into(),
            segments: vec![json!({"id":"s1","text":"Friday remains a proposal.","startMs":12000})],
            outline: "# Agenda\n\nReview the date.".into(),
            conclusions: vec![
                json!({"conclusionText":"## Decision\n\nNo final date.\n[Reference](https://example.com)"}),
                json!({"conclusionText":"<!DOCTYPE html><html><style>:root { color: red; }</style><body>Visual report</body></html>"}),
                json!({"conclusionText":"# Visual\n\n![chart](data:image/png;base64,aGVsbG8=)"}),
                json!({"conclusionText":"@media screen { body { font-family: sans-serif; } }"}),
            ],
            ..Default::default()
        };
        let filtered = source(original.clone()).unwrap();
        assert_eq!(filtered.revision, original.revision);
        assert_eq!(filtered.transcript, original.transcript);
        assert_eq!(filtered.segments, original.segments);
        assert_eq!(filtered.conclusions.len(), 1);
        assert!(filtered.text().contains("No final date."));
        assert!(!filtered.text().contains("base64"));
        assert!(!filtered.text().contains("<style>"));
        assert_eq!(original.conclusions.len(), 4);
        let twice = source(filtered.clone()).unwrap();
        assert_eq!(twice.text(), filtered.text());
    }

    #[test]
    fn skips_pages_with_no_markdown_and_preserves_plain_text_comparisons_and_links() {
        for text in [
            "<html><body>Only rendered content</body></html>",
            "![image](DATA:IMAGE/PNG;BASE64,aGVsbG8=)",
            "```css\n.card { color: red; }\n```",
        ] {
            assert!(source(Document {
                transcript: text.into(),
                ai_context_enabled: true,
                ..Default::default()
            })
            .is_none());
        }
        let text = "# Notes\n\n2 < 3; <https://example.com>\n\n- Follow up tomorrow";
        assert_eq!(
            source(Document {
                transcript: text.into(),
                ai_context_enabled: true,
                ..Default::default()
            })
            .unwrap()
            .transcript,
            text
        );
        assert!(source(Document {
            transcript: text.into(),
            ai_context_enabled: false,
            ..Default::default()
        })
        .is_none());
    }
}
