import { readFileSync, writeFileSync } from 'fs';
const f = 'src/components/AiChat.tsx';
let t = readFileSync(f, 'utf8');

// Fix: replace \n``, blocks, isComplete: false }} with \n`, blocks, isComplete: false }
const old = 'n``, blocks, isComplete: false }}';
const idx = t.indexOf(old);
if (idx !== -1) {
  const lineStart = t.lastIndexOf('\n', idx);
  console.log('Found at', idx, 'line context:', t.slice(lineStart, idx + old.length + 20));
  t = t.replace(old, 'n`, blocks, isComplete: false }');
  console.log('Fixed!');
} else {
  console.log('Pattern not found');
  // Alternative: find the specific line by content
  const idx2 = t.indexOf('blocks, isComplete: false }}');
  if (idx2 !== -1) {
    console.log('Found double-brace at', idx2);
    console.log(t.slice(Math.max(0, idx2 - 80), idx2 + 40));
    t = t.replace('blocks, isComplete: false }}', 'blocks, isComplete: false }');
    console.log('Fixed double brace');
  }
}

// Also check for double backtick issue
const dbt = t.indexOf('\\n``,');
if (dbt !== -1) {
  console.log('Double backtick at', dbt);
  t = t.replace('\\n``,', '\\n`,');
  console.log('Fixed double backtick');
}

writeFileSync(f, t, 'utf8');
console.log('Done');