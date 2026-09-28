import {access,rm} from 'node:fs/promises';
await access(new URL('../dist/client/index.html',import.meta.url));
// The Cloudflare Vite plugin is used only while prerendering. Deployment serves
// static assets from the root Wrangler config, never its generated SSR worker.
await rm(new URL('../.wrangler/deploy',import.meta.url),{recursive:true,force:true});
await rm(new URL('../dist/server',import.meta.url),{recursive:true,force:true});
console.log('Static deployment ready: dist/client');
