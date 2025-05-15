#!/usr/bin/env node
/**
 * index.js - DOCX → static site converter (Fixed version)
 * Generates /public with chapter pages, images, conlang hover, dark/light mode.
 * Requires Node 18+ and: npm i mammoth cheerio fs-extra
 */

import fse from 'fs-extra';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/* -------------------------------------------------- Configuration ------- */
const config = {
  inputFile: './input/novel.docx',   // put your DOCX here or change the path
  outputDir: './public',
  novelTitle: 'Your Novel Title',
  minimalProcessing: false,
  skipChapters: [],                  // e.g. ['chapter-23']
  skipConlangProcessing: false,
  chunkSize: 2000,
  processingTimeout: 10_000
};

/* -------------------------------------------------- Utilities ----------- */
const timer = label => {
  const start = performance.now();
  return () => `${label}: ${(performance.now() - start).toFixed(0)} ms`;
};

const escapeHTML = s =>
  s.replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   .replace(/'/g, '&#39;');

const logStep = msg => console.log('\x1b[36m●\x1b[0m', msg);
const logError = msg => console.error('\x1b[31m✗\x1b[0m', msg);
const logSuccess = msg => console.log('\x1b[32m✔\x1b[0m', msg);

/* -------------------------------------------------- Conlang helpers ----- */
// Match various footnote patterns: [1F], 1F, 1F1F, etc.
const REF_RX = /\[(\d+)F\]|(\d+)F(?:\2F)?/g;
const NORMALIZE_RX = /(\d+)F\1F/g;         // 7F7F → 7F
const normalizeRefs = txt => txt.replace(NORMALIZE_RX, '$1F');

function extractFootnotes($) {
  const map = new Map();
  
  // Try multiple selectors for footnotes - expanded list
  const footnoteSelectors = [
    '[id^="footnote-"]',
    '[id^="sdfootnote"]', 
    '[id^="_ftn"]',
    '[id^="fn"]',
    '.footnote',
    '.MsoFootnoteText',
    '[class*="footnote"]',
    'div[id*="footnote"]',
    'p[id*="footnote"]',
    'span[id*="footnote"]'
  ];
  
  $(footnoteSelectors.join(', ')).each((_, el) => {
    const $el = $(el);
    const id = $el.attr('id') || '';
    const text = $el.text().trim();
    
    // Extract number from various patterns
    let num = null;
    
    // Try to get number from id
    if (id) {
      const idMatch = id.match(/(\d+)/);
      if (idMatch) num = idMatch[1];
    }
    
    // Try to get number from beginning of text
    if (!num) {
      const textMatch = text.match(/^(\d+)[\s\.\)]/);
      if (textMatch) num = textMatch[1];
    }
    
    // Try to find footnote references in the text itself
    if (!num) {
      const refMatch = text.match(/\[(\d+)\]|^(\d+)$/);
      if (refMatch) num = refMatch[1] || refMatch[2];
    }
    
    if (num && text) {
      // Clean the text - remove number prefixes more aggressively
      let cleanText = text
        .replace(/^[\[\(]?\d+[\]\)]?[\s\.\)]*/, '')  // Remove [1], (1), 1., 1), etc.
        .replace(/^\d+\s*/, '')                      // Remove plain numbers
        .trim();
      
      if (cleanText) {
        map.set(num, cleanText);
        logStep(`Found footnote ${num}: ${cleanText.substring(0, 50)}...`);
      }
    }
  });
  
  // Also check for footnotes in superscript or special formatting
  $('sup, sub').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const numMatch = text.match(/^\d+$/);
    
    if (numMatch) {
      const num = numMatch[0];
      // Look for the footnote text nearby
      const $parent = $el.parent();
      const parentText = $parent.text();
      const footnoteMatch = parentText.match(new RegExp(`${num}[\\s\\.:]*(.+)`));
      
      if (footnoteMatch) {
        map.set(num, footnoteMatch[1].trim());
      }
    }
  });
  
  return map;
}

function processConlangInText(text, footMap) {
  // First, normalize all footnote references (7F7F → 7F)
  let processed = text.replace(/(\d+)F\1F/g, '$1F');
  
  // Then replace all footnote patterns with conlang spans
  processed = processed.replace(/\[(\d+)F?\]|(\d+)F/g, (match, g1, g2) => {
    const num = g1 || g2;
    const trans = footMap.get(num);
    
    if (!trans) {
      logError(`Missing translation for footnote ${num}`);
      return `<span class="conlang missing" data-tr="[translation missing for ${num}]">${num}F</span>`;
    }
    
    return `<span class="conlang" data-tr="${escapeHTML(trans)}">${num}F</span>`;
  });
  
  return processed;
}

function enrichConlang($scope, $, footMap) {
  // Process all text nodes
  $scope.find('*').contents().each((_, node) => {
    if (node.type === 'text' && node.data) {
      const processed = processConlangInText(node.data, footMap);
      if (processed !== node.data) {
        $(node).replaceWith(processed);
      }
    }
  });
  
  // Also process any text that might be in attributes
  $scope.find('[title], [alt]').each((_, el) => {
    const $el = $(el);
    ['title', 'alt'].forEach(attr => {
      const value = $el.attr(attr);
      if (value) {
        const processed = processConlangInText(value, footMap);
        if (processed !== value) {
          $el.attr(attr, processed);
        }
      }
    });
  });
}

/* -------------------------------------------------- Styling / scripts --- */
const baseCSS = /* css */`
:root {
  --bg: #fafafa;
  --fg: #222;
  --accent: #2e8bff;
  --border: #ddd;
}

[data-theme="dark"] {
  --bg: #111;
  --fg: #ddd;
  --accent: #7aa6ff;
  --border: #444;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.65;
  transition: background-color 0.3s, color 0.3s;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

/* Sidebar */
.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 280px;
  background: var(--bg);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  transform: translateX(-280px);
  transition: transform 0.3s;
  z-index: 100;
  padding: 1rem;
}

.sidebar.open {
  transform: translateX(0);
}

.sidebar h2 {
  margin-top: 0;
  padding: 0.5rem 0;
  border-bottom: 2px solid var(--accent);
}

.sidebar ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.sidebar li {
  margin: 0.5rem 0;
}

.sidebar .current {
  font-weight: bold;
  color: var(--accent);
}

/* Content */
.content {
  margin-left: 0;
  padding: 2rem;
  max-width: 800px;
  margin: 0 auto;
}

@media (min-width: 1024px) {
  .sidebar {
    transform: translateX(0);
  }
  
  .content {
    margin-left: 280px;
  }
}

/* Toggle button */
#toggle {
  position: fixed;
  top: 1rem;
  left: 1rem;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  z-index: 200;
  font-size: 1.2rem;
}

@media (min-width: 1024px) {
  #toggle {
    display: none;
  }
}

/* Theme toggle */
#theme {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 1rem;
}

/* Conlang tooltips */
.conlang {
  font-style: italic;
  position: relative;
  cursor: help;
  color: var(--accent);
  transition: all 0.2s;
}

.conlang:hover {
  filter: brightness(1.2);
}

.conlang::after {
  content: attr(data-tr);
  position: absolute;
  bottom: 1.8em;
  left: 50%;
  transform: translateX(-50%) scale(0.9);
  background: var(--bg);
  border: 2px solid var(--accent);
  padding: 0.5rem 0.75rem;
  font-style: normal;
  white-space: nowrap;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  opacity: 0;
  pointer-events: none;
  transition: all 0.3s;
  z-index: 1000;
}

.conlang:hover::after {
  opacity: 1;
  transform: translateX(-50%) scale(1);
}

.conlang.missing {
  color: #ff6b6b;
}

/* UI elements */
.ui {
  font-family: 'Courier New', monospace;
  background: var(--accent);
  background: linear-gradient(45deg, var(--accent), color-mix(in srgb, var(--accent) 70%, white));
  color: white;
  padding: 0.2em 0.5em;
  border-radius: 3px;
  display: inline-block;
  animation: typing 1s ease-out forwards;
}

@keyframes typing {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Images */
img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 2rem auto;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  transition: transform 0.3s, box-shadow 0.3s;
}

img:hover {
  transform: scale(1.02);
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);
}

/* Chapter navigation */
.chapter-nav {
  display: flex;
  justify-content: space-between;
  margin: 3rem 0;
  padding: 1rem 0;
  border-top: 1px solid var(--border);
}

.chapter-nav a {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: white;
  border-radius: 4px;
  transition: background-color 0.3s;
}

.chapter-nav a:hover {
  background: color-mix(in srgb, var(--accent) 80%, black);
  text-decoration: none;
}

/* Footer */
footer {
  margin-top: 4rem;
  padding-top: 2rem;
  border-top: 1px solid var(--border);
  text-align: center;
  opacity: 0.7;
  font-size: 0.9rem;
}
`;

const baseJS = /* js */`
(() => {
  const root = document.documentElement;
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.getElementById('toggle');
  const theme = document.getElementById('theme');
  
  // Mobile menu toggle
  toggle?.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    const isOpen = sidebar.classList.contains('open');
    localStorage.setItem('sidebarOpen', isOpen);
  });
  
  // Theme toggle
  theme?.addEventListener('click', () => {
    const currentTheme = root.dataset.theme;
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = newTheme;
    localStorage.setItem('theme', newTheme);
  });
  
  // Restore preferences
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = savedTheme || (prefersDark ? 'dark' : 'light');
  
  const savedSidebar = localStorage.getItem('sidebarOpen');
  if (savedSidebar === 'true' && window.innerWidth < 1024) {
    sidebar.classList.add('open');
  }
  
  // Close sidebar on outside click (mobile)
  document.addEventListener('click', (e) => {
    if (window.innerWidth < 1024 && 
        sidebar.classList.contains('open') && 
        !sidebar.contains(e.target) && 
        e.target !== toggle) {
      sidebar.classList.remove('open');
      localStorage.setItem('sidebarOpen', false);
    }
  });
})();
`;

/* -------------------------------------------------- Conversion helpers --- */
async function docxToHtml(buffer) {
  const imageCounter = { value: 0 };
  
  const options = {
    convertImage: mammoth.images.imgElement(image => {
      const ext = image.contentType.split('/')[1] || 'png';
      const imgName = `img-${++imageCounter.value}.${ext}`;
      const imgPath = path.join(config.outputDir, 'images', imgName);
      
      return image.read('base64').then(data => {
        fse.outputFileSync(imgPath, Buffer.from(data, 'base64'));
        return { src: `./images/${imgName}` };
      });
    }),
    styleMap: [
      // Map superscript footnote references
      "r[style-name='FootnoteReference'] => span.footnote-ref",
      "r[style-name='EndnoteReference'] => span.footnote-ref"
    ]
  };
  
  const result = await mammoth.convertToHtml({ buffer }, options);
  return result.value;
}

function parseAndCleanFootnotes(html) {
  const $ = cheerio.load(html);
  
  // Find and remove actual footnote text sections (usually at end of document)
  const footnoteSections = [
    'div[id*="footnote"]',
    'div[class*="footnote"]',
    'section[id*="footnote"]',
    'section[class*="footnote"]'
  ];
  
  const footnotes = new Map();
  
  // Extract footnotes from designated sections
  $(footnoteSections.join(', ')).each((_, section) => {
    const $section = $(section);
    
    // Look for individual footnotes within sections
    $section.find('p, div, span').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      const idMatch = ($el.attr('id') || '').match(/(\d+)/);
      const textMatch = text.match(/^(\d+)[\s\.\)]/);
      
      const num = idMatch?.[1] || textMatch?.[1];
      if (num) {
        const cleanText = text.replace(/^[\[\(]?\d+[\]\)]?[\s\.\)]*/, '').trim();
        if (cleanText) {
          footnotes.set(num, cleanText);
        }
      }
    });
    
    // Remove the footnote section from the HTML
    $section.remove();
  });
  
  // Clean up inline footnote references
  $('.footnote-ref, sup').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    
    // If it's just a number, it might be a footnote reference
    if (/^\d+$/.test(text)) {
      $el.replaceWith(`[${text}F]`);
    }
  });
  
  return {
    cleanedHtml: $.html(),
    footnotes
  };
}

function parseChapters(html) {
  const $ = cheerio.load(html);
  const chapters = [];
  
  // Find all headings that could be chapter titles
  const headings = $('h1, h2').toArray();
  
  headings.forEach((heading, index) => {
    const $heading = $(heading);
    const titleText = $heading.text().trim();
    
    // Determine if this is a chapter or front matter
    let isChapter = false;
    let chapterNum = null;
    
    // Check for chapter patterns
    const chapterMatch = titleText.match(/chapter\s+(\d+|[a-z]+)/i);
    if (chapterMatch) {
      isChapter = true;
      chapterNum = chapterMatch[1];
    }
    
    // Check for numbered chapters without "Chapter" prefix
    const numberMatch = titleText.match(/^(\d+)\s*[:.–-]?\s*.*/);
    if (numberMatch && !isChapter) {
      isChapter = true;
      chapterNum = numberMatch[1];
    }
    
    // Collect all content until the next heading
    const $content = $('<div>');
    let $current = $heading.next();
    
    while ($current.length && !$current.is('h1, h2')) {
      $content.append($current.clone());
      $current = $current.next();
    }
    
    chapters.push({
      title: titleText,
      isChapter,
      chapterNum,
      heading: $heading.clone(),
      content: $content.html() || '',
      index
    });
  });
  
  // If no chapters found, treat the whole document as one chapter
  if (chapters.length === 0) {
    chapters.push({
      title: 'Full Document',
      isChapter: false,
      chapterNum: null,
      heading: $('<h1>').text('Full Document'),
      content: $('body').html() || $.root().html(),
      index: 0
    });
  }
  
  return chapters;
}

function generateId(chapter, index) {
  if (chapter.chapterNum) {
    return `chapter-${chapter.chapterNum}`;
  }
  
  // Special cases for common front matter
  const lowerTitle = chapter.title.toLowerCase();
  if (lowerTitle.includes('preface')) return 'preface';
  if (lowerTitle.includes('prologue')) return 'prologue';
  if (lowerTitle.includes('epilogue')) return 'epilogue';
  if (lowerTitle.includes('acknowledgment')) return 'acknowledgments';
  if (lowerTitle.includes('dedication')) return 'dedication';
  if (lowerTitle.includes('contents')) return 'toc';
  
  // Default to index-based ID
  return index === 0 ? 'front-matter' : `section-${index}`;
}

function renderPage({ title, sidebar, body, navLinks = '' }) {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
  <style>${baseCSS}</style>
</head>
<body>
  <button id="toggle">☰</button>
  
  <nav class="sidebar">
    <h2>Table of Contents</h2>
    ${sidebar}
  </nav>
  
  <main class="content">
    <header style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
      <h1>${escapeHTML(title)}</h1>
      <button id="theme">🌓</button>
    </header>
    
    ${body}
    
    ${navLinks}
    
    <footer>
      Generated by novel2site.js
    </footer>
  </main>
  
  <script>${baseJS}</script>
</body>
</html>`;
}

/* -------------------------------------------------- Main ----------------- */
(async () => {
  const tAll = timer('Total');
  
  try {
    // Setup directories
    await fse.emptyDir(config.outputDir);
    await fse.ensureDir(path.join(config.outputDir, 'images'));
    
    // Read DOCX
    logStep('Reading DOCX file...');
    const buffer = await fse.readFile(config.inputFile);
    
    // Convert to HTML
    logStep('Converting to HTML...');
    const rawHtml = await docxToHtml(buffer);
    
    // Parse and clean footnotes
    logStep('Processing footnotes...');
    const { cleanedHtml, footnotes: extractedFootnotes } = parseAndCleanFootnotes(rawHtml);
    
    // Parse chapters from cleaned HTML
    logStep('Parsing chapters...');
    const chapters = parseChapters(cleanedHtml);
    logStep(`Found ${chapters.length} sections`);
    
    // Extract additional footnotes from full document
    const $full = cheerio.load(cleanedHtml);
    const additionalFootnotes = extractFootnotes($full);
    
    // Merge footnotes
    const footMap = new Map([...extractedFootnotes, ...additionalFootnotes]);
    logStep(`Found ${footMap.size} total footnotes`);
    
    // Log footnote mappings for debugging
    if (footMap.size > 0) {
      logStep('Footnote mappings:');
      footMap.forEach((text, num) => {
        console.log(`  ${num}: "${text.substring(0, 60)}..."`);
      });
    }
    
    // Process each chapter
    const toc = [];
    const processedChapters = [];
    
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const id = generateId(chapter, i);
      
      if (config.skipChapters.includes(id)) {
        logStep(`Skipping ${id}`);
        continue;
      }
      
      logStep(`Processing: ${chapter.title}`);
      
      const $ = cheerio.load(`<div>${chapter.heading}${chapter.content}</div>`);
      const $body = $('body').length ? $('body') : $.root();
      
      // Process conlang
      if (!config.skipConlangProcessing && footMap.size > 0) {
        enrichConlang($body, $, footMap);
      }
      
      // Process UI elements
      $body.find('p').each((_, p) => {
        const $p = $(p);
        const html = $p.html();
        if (html && /\[.*?\]/.test(html)) {
          $p.html(html.replace(/\[([^\]]+)\]/g, (match, content) => {
            // Don't process footnote references as UI elements
            if (/^\d+F?$/.test(content)) {
              return match;
            }
            return `<span class="ui">[$1]</span>`;
          }));
        }
      });
      
      // Fix image paths
      $body.find('img').each((_, img) => {
        const $img = $(img);
        const src = $img.attr('src');
        if (src && !src.startsWith('http')) {
          $img.attr('src', src.replace(/^\.\.\//, './'));
        }
      });
      
      processedChapters.push({
        id,
        title: chapter.title,
        content: $body.html(),
        isChapter: chapter.isChapter,
        index: i
      });
      
      toc.push({
        id,
        title: chapter.title,
        isChapter: chapter.isChapter
      });
    }
    
    // Generate sidebar HTML
    const sidebarHtml = `
      <ul>
        ${toc.map(item => `
          <li>
            <a href="./${item.id}.html" ${item.isChapter ? 'style="font-weight: 500;"' : ''}>
              ${escapeHTML(item.title)}
            </a>
          </li>
        `).join('')}
      </ul>
    `;
    
    // Write chapter files
    for (let i = 0; i < processedChapters.length; i++) {
      const chapter = processedChapters[i];
      const prev = processedChapters[i - 1];
      const next = processedChapters[i + 1];
      
      // Generate navigation links
      const navLinks = `
        <nav class="chapter-nav">
          ${prev ? `<a href="./${prev.id}.html">← ${escapeHTML(prev.title)}</a>` : '<span></span>'}
          ${next ? `<a href="./${next.id}.html">${escapeHTML(next.title)} →</a>` : '<span></span>'}
        </nav>
      `;
      
      const page = renderPage({
        title: `${chapter.title} - ${config.novelTitle}`,
        sidebar: sidebarHtml,
        body: chapter.content,
        navLinks
      });
      
      await fse.outputFile(path.join(config.outputDir, `${chapter.id}.html`), page);
    }
    
    // Write index page
    logStep('Creating index page...');
    const indexPage = renderPage({
      title: config.novelTitle,
      sidebar: sidebarHtml,
      body: `
        <h2>Welcome</h2>
        <p>Select a chapter from the sidebar to begin reading.</p>
        
        <h3>Chapters</h3>
        <ul>
          ${toc.filter(item => item.isChapter).map(item => `
            <li><a href="./${item.id}.html">${escapeHTML(item.title)}</a></li>
          `).join('')}
        </ul>
        
        ${toc.some(item => !item.isChapter) ? `
          <h3>Additional Content</h3>
          <ul>
            ${toc.filter(item => !item.isChapter).map(item => `
              <li><a href="./${item.id}.html">${escapeHTML(item.title)}</a></li>
            `).join('')}
          </ul>
        ` : ''}
      `
    });
    
    await fse.outputFile(path.join(config.outputDir, 'index.html'), indexPage);
    
    logSuccess(`Done! ${tAll()}`);
    logSuccess(`Created ${processedChapters.length} pages in ${config.outputDir}`);
    
  } catch (error) {
    logError(`Error: ${error.message}`);
    console.error(error.stack);
    
    if (config.minimalProcessing) {
      logStep('Attempting minimal fallback...');
      try {
        const result = await mammoth.convertToHtml({ path: config.inputFile });
        const fallbackPage = renderPage({
          title: config.novelTitle,
          sidebar: '',
          body: `<article>${result.value}</article>`
        });
        
        await fse.outputFile(
          path.join(config.outputDir, 'index.html'),
          fallbackPage
        );
        
        logSuccess('Created fallback single-page version');
      } catch (fallbackError) {
        logError(`Fallback also failed: ${fallbackError.message}`);
      }
    }
  }
})();
