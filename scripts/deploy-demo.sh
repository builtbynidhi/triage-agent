#!/usr/bin/env bash
# Deploy the public demo (apps/web, snapshot mode) to Vercel production.
#
#   pnpm install            # once, so the tested package versions can be read
#   npx vercel@latest login # once, in a terminal (it opens your browser)
#   bash scripts/deploy-demo.sh
#
# Why a script and not "import the repo": it needs no GitHub authorization, and it deploys exactly
# the versions that were tested. It builds a small standalone folder (the web app's source, the
# snapshot, and an exact-version package.json plus lockfile) in a temp directory, checks that it
# builds on its own, and sends that to Vercel. Nothing from the rest of the repo is uploaded: no
# .env, no recordings, no database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/apps/web"
PROJECT="${VERCEL_PROJECT:-triage-agent-demo}"
[ -d "$WEB/node_modules/next" ] || { echo "run 'pnpm install' first" >&2; exit 1; }

DIR="$(mktemp -d)/$PROJECT"
mkdir -p "$DIR"
rsync -a --exclude node_modules --exclude .next --exclude '*.test.ts' --exclude tsconfig.tsbuildinfo \
  --exclude next-env.d.ts --exclude vercel.json --exclude package.json --exclude .vercel "$WEB/" "$DIR/"

# Exact versions, read from what is installed and tested in the workspace.
WEB="$WEB" DIR="$DIR" PROJECT="$PROJECT" node -e "
const { readFileSync, writeFileSync } = require('node:fs');
const v = (n) => JSON.parse(readFileSync(process.env.WEB + '/node_modules/' + n + '/package.json', 'utf8')).version;
const pkg = {
  name: process.env.PROJECT, private: true, version: '0.0.0',
  scripts: { build: 'next build', start: 'next start' },
  dependencies: { next: v('next'), react: v('react'), 'react-dom': v('react-dom') },
  devDependencies: {
    tailwindcss: v('tailwindcss'), '@tailwindcss/postcss': v('@tailwindcss/postcss'), postcss: v('postcss'),
    typescript: '5.9.3', '@types/react': v('@types/react'), '@types/react-dom': v('@types/react-dom'), '@types/node': v('@types/node'),
  },
};
writeFileSync(process.env.DIR + '/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
printf '{\n  "framework": "nextjs"\n}\n' > "$DIR/vercel.json"
printf '.next\nnode_modules\n.vercel\n' > "$DIR/.gitignore"

cd "$DIR"
npm install --package-lock-only --ignore-scripts >/dev/null
echo "checking that the standalone folder builds by itself..."
npm ci --ignore-scripts >/dev/null
npx next build >/dev/null
rm -rf node_modules .next

npx --yes vercel@latest link --yes --project "$PROJECT" >/dev/null
npx --yes vercel@latest deploy --prod --yes
