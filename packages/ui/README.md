# Company UI

Owner: `feat/company-web`. Provides replaceable design tokens, a Logo slot, and business-neutral UI
primitives. Feature-specific cards and forms remain in `apps/company-web`.

The current public surface exports `LogoSlot`, buttons, fields, badges, alerts, and loading
primitives plus `@company/ui/tokens.css`. Radix-backed Dialog/Toast/Tooltip primitives are pending
the root lockfile dependency synchronization recorded in `apps/company-web/README.md`.
