# Changelog

## 0.1.0 (Phase 1 — Empty Shell)
- Established module structure and package.json
- Defined Capability View class hierarchy (ReadOnlyView, CeAccessView, CerebellumL1View, CerebellumL2View)
- ReadOnlyView returns empty results; CeAccessView.touchAccess is no-op; write methods throw NotImplementedError
- Added schema.sql with full DDL (memories, tags, edges, memory_audit)
- Added JSDoc type definitions
