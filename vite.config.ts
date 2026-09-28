import vinext from 'vinext';
import {defineConfig} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';
export default defineConfig({plugins:[vinext(),cloudflare({configPath:false,viteEnvironment:{name:'rsc',childEnvironments:['ssr']},config:{name:'chalupa-export-build',main:'vinext/server/fetch-handler',compatibility_date:'2026-09-28',compatibility_flags:['nodejs_compat']}})]});
