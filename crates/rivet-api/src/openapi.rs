//! `OpenAPI` document for the Rivet control API (contract source for Effect Schema).

use utoipa::OpenApi;

use crate::{
    AccountInfo, LocalSession, OnboardingStatus, PublicConfig, StatusResponse, WorkersStatus,
};
use rivet_core::{Capabilities, ConversationSummary, LiveCursor, CaptureEvent, UsageTotals};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Rivet Control API",
        version = "0.1.0",
        description = "Local control plane for the Rivet desktop app, CLI, and ingest."
    ),
    paths(
        crate::status,
        crate::get_config,
        crate::recent,
        crate::openapi_json,
        crate::live_cursor_doc,
        crate::live_events_doc,
    ),
    components(schemas(
        StatusResponse,
        WorkersStatus,
        OnboardingStatus,
        PublicConfig,
        LocalSession,
        AccountInfo,
        Capabilities,
        UsageTotals,
        CaptureEvent,
        ConversationSummary,
        LiveCursor,
    )),
    tags(
        (name = "control", description = "Status, config, and session bootstrap"),
        (name = "capture", description = "Capture event queries"),
        (name = "live", description = "Live cursor / SSE refresh"),
    )
)]
pub struct ApiDoc;
