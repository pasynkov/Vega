## ADDED Requirements

### Requirement: Top-supervisor exposes open_immersive_session

The top-supervisor spec SHALL include the kernel-tool `open_immersive_session({domain, intent?})`. The tool SHALL NOT be present in any domain-supervisor-spec (intent detection for immersive entry SHALL live exclusively at the top level). The list of valid `domain` values SHALL be sourced at runtime from `ImmersiveDomainRegistry.list()`. The system prompt SHALL include a dynamic block enumerating the currently registered immersive domains and the intent-mapping rule:

> Доступные immersive-домены: `{registry.list().join(", ")}`. Если пользователь говорит "погружаемся в X" / "давай в X" / "открой режим X" где X — один из перечисленных — вызови `open_immersive_session({domain: X, intent})`.

#### Scenario: Top-supervisor routes immersive intent

- **WHEN** the top-supervisor receives the final `"погружаемся в покупки"`
- **AND** `shopping` is in the registry
- **THEN** the top-supervisor SHALL invoke `open_immersive_session({domain: "shopping", intent: "погружение"})`
- **AND** SHALL NOT route the final into the shopping supervisor-spec

#### Scenario: Top-supervisor system prompt lists registered domains

- **WHEN** the supervisor spec is built at `OnApplicationBootstrap` after all domains have registered
- **THEN** the system prompt SHALL contain the substring with `registry.list().join(", ")` rendered (e.g. `"shopping"` when shopping is the only immersive domain)
