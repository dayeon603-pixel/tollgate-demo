# Vendored third-party code

Files here are copied byte for byte from their published release. They are served from this site's own
origin; nothing is loaded from a CDN at runtime (the pages' Content Security Policy is self-only).

## Apache ECharts 5.6.0

| | |
|---|---|
| File | `echarts.min.js` (full UMD build, sets `globalThis.echarts`) |
| Version | 5.6.0 |
| Source | https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js |
| SHA-256 | `bf4a223524e40b77c304bec67e1222cf551f14880cf42c69dc046558e11c07b1` |
| Size | 1,034,102 bytes |
| Downloaded | 2026-11-10 |
| License | Apache License 2.0, full text in `ECHARTS-LICENSE.txt` (from https://cdn.jsdelivr.net/npm/echarts@5.6.0/LICENSE, SHA-256 `634293835b43a6dd2094fa39182a3d9a6b9ca43b7fdb9ac354e8037af2a3093a`) |
| Notice | `ECHARTS-NOTICE.txt` (from https://cdn.jsdelivr.net/npm/echarts@5.6.0/NOTICE, SHA-256 `fa99ac3af859d0e13166906dc53a73ad34a08898da7e8ae83407275496e9e30c`) |

Apache ECharts, Copyright 2017-2024 The Apache Software Foundation. This product includes software
developed at The Apache Software Foundation (https://www.apache.org/). The ECharts bundle includes
ZRender (BSD-3-Clause, https://github.com/ecomfe/zrender/blob/master/LICENSE.txt).

To check the file: `shasum -a 256 js/vendor/echarts.min.js`.

It is loaded by `app.html` with a plain `<script defer>` before the app module, and used only through
`js/ws/echart.js`.
