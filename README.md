# Tollgate demo

A static page that checks three sample Tollgate receipts in the browser, using Web Crypto for the Ed25519 signature and the SHA-256 hash chain, with no build step and no requests beyond its own files; serve the folder from any path over HTTP (for example `python3 -m http.server`), because the page loads its sample data with a relative URL and will not run from `file://`. The payments are made up and the signing key is a published demo key. All rights reserved.
