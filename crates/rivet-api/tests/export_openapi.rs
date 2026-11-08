//! Snapshot the control-plane OpenAPI document into `docs/openapi.json`.
//!
//! Run: `cargo test -p rivet-api --test export_openapi -- --ignored`
//! Or: `./scripts/export-openapi.sh`

use std::path::PathBuf;

#[test]
#[ignore = "writes docs/openapi.json — run via scripts/export-openapi.sh"]
fn export_openapi_doc() {
    let doc = rivet_api::openapi_document();
    let json = doc.to_pretty_json().expect("serialize openapi");
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/openapi.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, format!("{json}\n")).expect("write openapi.json");
    assert!(path.exists(), "wrote {}", path.display());
}

#[test]
fn openapi_includes_core_contracts() {
    let doc = rivet_api::openapi_document();
    let json = doc.to_json().expect("json");
    for needle in [
        "StatusResponse",
        "PublicConfig",
        "TrafficEvent",
        "LiveCursor",
        "/v1/status",
        "/v1/live",
        "/v1/events",
        "/v1/openapi.json",
    ] {
        assert!(json.contains(needle), "openapi missing {needle}");
    }
}
