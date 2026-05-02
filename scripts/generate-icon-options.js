'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'extension', 'icons', 'options');
const SIZES = [16, 32, 48, 128];

const palette = {
  ink: '#1a1613',
  paper: '#fffdf9',
  warm: '#f8f5f0',
  line: '#e8e2da',
  amber: '#c8713a',
  green: '#3d7a4a',
  blue: '#3f6f91',
  red: '#b35a5a',
};

const options = [
  {
    key: 'a-stacked-tabs',
    label: 'A',
    name: 'Stacked Tabs',
    summary: 'Most direct: many browser tabs gathered into one clean place.',
    previewLines: ['Many open tabs', 'gathered together.'],
    body: `
      <rect x="5" y="5" width="118" height="118" rx="25" fill="${palette.ink}"/>
      <path d="M25 30H51C58 30 61 36 64 41H98C104 41 109 46 109 52V92C109 99 104 104 97 104H31C24 104 19 99 19 92V36C19 33 22 30 25 30Z" fill="${palette.blue}" opacity="0.55"/>
      <path d="M28 24H56C63 24 66 30 69 36H102C108 36 113 41 113 47V89C113 96 108 101 101 101H29C22 101 17 96 17 89V30C17 27 21 24 28 24Z" fill="${palette.green}" opacity="0.7"/>
      <path d="M22 38H51C59 38 62 44 65 50H100C107 50 112 55 112 62V96C112 103 107 108 100 108H28C21 108 16 103 16 96V44C16 41 19 38 22 38Z" fill="${palette.paper}"/>
      <path d="M22 38H51C59 38 62 44 65 50H100C107 50 112 55 112 62V96C112 103 107 108 100 108H28C21 108 16 103 16 96V44C16 41 19 38 22 38Z" fill="none" stroke="${palette.ink}" stroke-width="6" stroke-linejoin="round"/>
      <path d="M32 66H83" stroke="${palette.ink}" stroke-width="8" stroke-linecap="round"/>
      <path d="M32 84H68" stroke="${palette.amber}" stroke-width="8" stroke-linecap="round"/>
    `,
  },
  {
    key: 'b-tab-tree',
    label: 'B',
    name: 'Tab Tree',
    summary: 'Strongest match for the new feature: temporary folders and links.',
    previewLines: ['Folders and links', 'as a lightweight tree.'],
    body: `
      <rect x="5" y="5" width="118" height="118" rx="25" fill="${palette.paper}"/>
      <rect x="5" y="5" width="118" height="118" rx="25" fill="none" stroke="${palette.ink}" stroke-width="7"/>
      <path d="M39 42V86M39 64H57M39 42H57M39 86H57" stroke="${palette.ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="39" cy="42" r="10" fill="${palette.amber}" stroke="${palette.ink}" stroke-width="5"/>
      <circle cx="39" cy="64" r="8" fill="${palette.green}" stroke="${palette.ink}" stroke-width="5"/>
      <circle cx="39" cy="86" r="8" fill="${palette.blue}" stroke="${palette.ink}" stroke-width="5"/>
      <path d="M62 30H82C87 30 90 34 92 39H99C105 39 109 43 109 49V56C109 62 105 66 99 66H67C61 66 57 62 57 56V35C57 32 59 30 62 30Z" fill="${palette.warm}" stroke="${palette.ink}" stroke-width="5" stroke-linejoin="round"/>
      <path d="M62 76H82C87 76 90 80 92 85H99C105 85 109 89 109 95V101C109 107 105 111 99 111H67C61 111 57 107 57 101V81C57 78 59 76 62 76Z" fill="${palette.warm}" stroke="${palette.ink}" stroke-width="5" stroke-linejoin="round"/>
      <path d="M70 51H94M70 96H94" stroke="${palette.ink}" stroke-width="5" stroke-linecap="round"/>
    `,
  },
  {
    key: 'c-hub-grid',
    label: 'C',
    name: 'Hub Grid',
    summary: 'Best for the product name: a central hub organizing tab cards.',
    previewLines: ['A central hub', 'organizing tab cards.'],
    body: `
      <rect x="5" y="5" width="118" height="118" rx="25" fill="${palette.amber}"/>
      <rect x="22" y="24" width="34" height="30" rx="8" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="5"/>
      <rect x="72" y="24" width="34" height="30" rx="8" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="5"/>
      <rect x="22" y="74" width="34" height="30" rx="8" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="5"/>
      <rect x="72" y="74" width="34" height="30" rx="8" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="5"/>
      <path d="M39 54V64H89V54M39 74V64M89 74V64" stroke="${palette.ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="64" cy="64" r="15" fill="${palette.ink}"/>
      <circle cx="64" cy="64" r="6" fill="${palette.paper}"/>
      <path d="M31 34H48M81 34H98M31 84H48M81 84H98" stroke="${palette.green}" stroke-width="5" stroke-linecap="round"/>
    `,
  },
  {
    key: 'd-pocket-tabs',
    label: 'D',
    name: 'Pocket Tabs',
    summary: 'Lightweight and calm: save temporary tabs without bookmark heaviness.',
    previewLines: ['Temporary tab saving', 'without bookmark weight.'],
    body: `
      <rect x="5" y="5" width="118" height="118" rx="25" fill="${palette.green}"/>
      <path d="M31 29H58C64 29 68 34 71 40H96C102 40 107 45 107 51V88C107 97 100 104 91 104H37C28 104 21 97 21 88V39C21 33 25 29 31 29Z" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="6" stroke-linejoin="round"/>
      <path d="M32 62C43 72 53 77 64 77C75 77 85 72 96 62" fill="none" stroke="${palette.ink}" stroke-width="7" stroke-linecap="round"/>
      <path d="M39 44H76" stroke="${palette.amber}" stroke-width="8" stroke-linecap="round"/>
      <path d="M39 56H88" stroke="${palette.ink}" stroke-width="6" stroke-linecap="round" opacity="0.82"/>
      <circle cx="93" cy="38" r="12" fill="${palette.blue}" stroke="${palette.ink}" stroke-width="5"/>
      <path d="M88 38H98" stroke="${palette.paper}" stroke-width="4" stroke-linecap="round"/>
    `,
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function wrapSvg(body, attrs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" ${attrs}>
${body.trim()}
</svg>
`;
}

function exportPng(source, dest, size) {
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', dest], {
    stdio: 'ignore',
  });
}

function generateOption(option) {
  const dir = path.join(OUTPUT_DIR, option.key);
  ensureDir(dir);

  const svgPath = path.join(dir, 'icon.svg');
  fs.writeFileSync(svgPath, wrapSvg(option.body));

  for (const size of SIZES) {
    exportPng(svgPath, path.join(dir, `icon${size}.png`), size);
  }
}

function generatePreview() {
  ensureDir(OUTPUT_DIR);
  const columns = options.map((option, index) => {
    const x = 34 + index * 214;
    const summary = option.previewLines.map((line, lineIndex) => {
      return `<text x="78" y="${191 + lineIndex * 16}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="11" fill="#6f6862">${line}</text>`;
    }).join('');
    return `
      <g transform="translate(${x} 48)">
        <rect x="-14" y="-14" width="184" height="330" rx="18" fill="#fffdf9" stroke="#e8e2da"/>
        <g transform="translate(14 0)">${option.body}</g>
        <text x="78" y="166" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="700" fill="${palette.ink}">${option.label}. ${option.name}</text>
        ${summary}
        <g transform="translate(9 232)">
          <g transform="scale(0.375)">${option.body}</g>
          <g transform="translate(58 8) scale(0.25)">${option.body}</g>
          <g transform="translate(105 16) scale(0.125)">${option.body}</g>
        </g>
        <text x="78" y="304" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="11" fill="#9a918a">128 / 48 / 32 / 16 generated</text>
      </g>
    `;
  }).join('');

  const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="430" viewBox="0 0 900 430">
    <rect width="900" height="430" fill="#f8f5f0"/>
    <text x="34" y="30" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="15" font-weight="700" fill="${palette.ink}">Tab Hub icon options</text>
    ${columns}
  </svg>
`;

  const svgPath = path.join(OUTPUT_DIR, 'preview.svg');
  const pngPath = path.join(OUTPUT_DIR, 'preview.png');
  fs.writeFileSync(svgPath, previewSvg);
  execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { stdio: 'ignore' });
}

function generateReadme() {
  const lines = [
    '# Tab Hub Icon Options',
    '',
    'Each option is generated from its own `icon.svg` source and exported before selection.',
    '',
    'Generated files per option:',
    '',
    '- `icon16.png`',
    '- `icon32.png`',
    '- `icon48.png`',
    '- `icon128.png`',
    '- `icon.svg`',
    '',
    'Options:',
    '',
    ...options.map(option => `- ${option.label}. ${option.name} (${option.key}): ${option.summary}`),
    '',
    'The active extension icon has not been replaced yet.',
    '',
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), lines.join('\n'));
}

ensureDir(OUTPUT_DIR);
for (const option of options) generateOption(option);
generatePreview();
generateReadme();

console.log(`Generated ${options.length} icon options in ${path.relative(ROOT, OUTPUT_DIR)}`);
