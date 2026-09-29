// ============================================================
//  Build de produção do front (Q1).
//  Mantém a arquitetura em camadas no desenvolvimento e gera,
//  para produção, um único bundle minificado em dist/.
//  - Concatena os js/ na ordem de dependência (scripts clássicos
//    que compartilham globais) e minifica com esbuild.
//  - Reescreve o index.html para apontar para o bundle único.
//  - Copia css/ e assets/ para dist/.
//  Uso:  npm run build
// ============================================================
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(raiz, 'dist');

// Ordem de carregamento (igual à do index.html)
const ordem = ['config', 'util', 'auth', 'api', 'repositories', 'services', 'ui', 'app'];

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, 'js'), { recursive: true });

  // 1) Concatena os arquivos de camada
  const partes = [];
  for (const nome of ordem) {
    partes.push(`/* ${nome}.js */\n` + (await readFile(join(raiz, 'js', `${nome}.js`), 'utf8')));
  }
  const fonte = partes.join('\n');

  // 2) Minifica
  const { code } = await esbuild.transform(fonte, {
    loader: 'js',
    minify: true,
    target: 'es2019',
    legalComments: 'none',
  });
  await writeFile(join(dist, 'js', 'app.min.js'), code, 'utf8');

  // 3) index.html apontando para o bundle único
  let html = await readFile(join(raiz, 'index.html'), 'utf8');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = ordem.map((n) => escapeRe(`<script src="js/${n}.js"></script>`)).join('\\s*');
  html = html.replace(new RegExp(tags), '<script src="js/app.min.js"></script>');
  await writeFile(join(dist, 'index.html'), html, 'utf8');

  // 4) Ativos estáticos
  await cp(join(raiz, 'css'), join(dist, 'css'), { recursive: true });
  await cp(join(raiz, 'assets'), join(dist, 'assets'), { recursive: true });

  const kb = (Buffer.byteLength(code) / 1024).toFixed(1);
  console.log(`Build OK -> dist/ (bundle: ${kb} KB minificado)`);
}

build().catch((e) => {
  console.error('Falha no build:', e);
  process.exit(1);
});
