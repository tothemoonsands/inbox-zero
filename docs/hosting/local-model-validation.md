# Local model validation

## Google Harness² mechanical validation

The local inference learning adapter reports version 2 `inbox_object_v1` receipts from SDK object validation and `inbox_tool_input_v1` receipts from SDK tool-call validation. Only typed parser/schema failures grade false; network and execution failures do not masquerade as input failures. These checks establish contract compliance, not correct mail decisions or delivery. Original provider routing, streaming, schemas, tools, permissions and execution are preserved. No extra model-facing tool or parameter is added.

Automatic promotion is limited to named tool-contract and structured-output checks. Broad quality suggestions remain observational. Saved lessons alone do not trigger repeated synthetic evaluation. No actions are replayed to obtain validation evidence.
