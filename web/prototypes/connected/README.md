# Connected prototype

Dedicated Reading Lite prototype based on Brian's preferred Connected direction.
It opens directly to the library and omits the design switcher, comparison
footer, and decision form. The tighter spacing and reduced interface copy carry
over from the comparison study.

The entrypoint, preview styling, development server, and build output are
separate. The authored samples, screens, and simulation remain shared with
`../interface-directions/`, so existing workflows stay consistent. This is still
a prototype: no production APIs, provider credentials, or live processing.

## Run

From `web/`:

```sh
npm run prototype:connected:dev
```

The dedicated server uses port 5174. For this host's tailnet interface:

```sh
npm run prototype:connected:dev -- --host 100.94.252.48
```

Open `http://100.94.252.48:5174/#/library`. Direct routes include `#/library`,
`#/reading/attention`, `#/capture`, and `#/provider`. Old comparison hash links
are normalized to these routes and always render Connected.

The compact toolbar retains phone/desktop, light/dark, and sample-state
controls. Search, tags, pagination, reading connections and tensions, URL and
Markdown capture, failures, and provider setup retain the shared simulation
behavior. Data resets on reload.

## Validate

```sh
npm run prototype:test
npm run prototype:connected:build
npm run prototype:build
```

The dedicated build outputs to ignored `web/dist-connected-prototype/`.
The three-direction comparison remains on port 5173 with its original build
command and output. Neither entrypoint is part of the production SPA build.
