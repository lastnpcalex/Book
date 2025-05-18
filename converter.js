// Novel to Web Converter - Enhanced Version with Style Improvements
// This version addresses chapter styling, appendix detection, footnote styling, and more

const fs = require('fs-extra');
const path = require('path');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const cheerio = require('cheerio');

/**
 * Main function to convert DOCX to interactive website
 * @param {string} docxPath - Path to the DOCX file
 * @param {string} outputDir - Directory to output the website
 */
async function convertNovelToWebsite(docxPath, outputDir) {
  console.log(`Starting conversion of ${docxPath} to ${outputDir}`);
  
  // Create output directories
  await fs.ensureDir(outputDir);
  await fs.ensureDir(path.join(outputDir, 'images'));
  await fs.ensureDir(path.join(outputDir, 'js'));
  await fs.ensureDir(path.join(outputDir, 'css'));
  await fs.ensureDir(path.join(outputDir, 'chapters'));
  await fs.ensureDir(path.join(outputDir, 'appendices'));
  
  // Extract images from DOCX
  console.log('Extracting images...');
  const imageMap = await extractImages(docxPath, path.join(outputDir, 'images'));
  
  // Extract HTML content with Mammoth's built-in footnote handling
  console.log('Extracting HTML content with footnotes...');
  const result = await mammoth.convertToHtml({ 
    path: docxPath,
    transformDocument: transformDocument
  });
  
  // Process the HTML content to extract structure and transform footnotes
  console.log('Processing document structure and footnotes...');
  const $ = cheerio.load(result.value);
  
  // Transform footnotes to superscript format
  transformFootnotes($);
  
  // Clean up any remaining nFnF artifacts
  cleanupArtifacts($);
  
  // Extract document structure
  const structure = extractDocumentStructure($);
  
  // Generate HTML files for all content
  console.log('Generating HTML files...');
  await generateHtmlFiles(structure, $, outputDir, imageMap);
  
  // Create template files (CSS, JS)
  console.log('Creating template files...');
  await createTemplateFiles(outputDir);
  
  console.log('Conversion complete!');
}

/**
 * Extract images from DOCX file
 * @param {string} docxPath - Path to DOCX file
 * @param {string} outputDir - Directory to save images
 * @returns {Object} - Map of image relationships to filenames
 */
async function extractImages(docxPath, outputDir) {
  const docxBuffer = await fs.readFile(docxPath);
  const zip = await JSZip.loadAsync(docxBuffer);
  
  // Find all image files in the DOCX
  const imageFiles = Object.keys(zip.files).filter(name => 
    name.startsWith('word/media/') && 
    !name.endsWith('/')
  );
  
  // Extract relationship file to map image IDs to files
  let relationshipMap = {};
  try {
    const relsXml = await zip.file('word/_rels/document.xml.rels').async('string');
    const $ = cheerio.load(relsXml, { xmlMode: true });
    
    $('Relationship').each((i, el) => {
      const id = $(el).attr('Id');
      const target = $(el).attr('Target');
      if (target && target.startsWith('media/')) {
        relationshipMap[id] = target.replace('media/', '');
      }
    });
  } catch (err) {
    console.warn('Could not read relationships file:', err.message);
  }
  
  // Extract each image file
  const imageMap = {};
  for (const imagePath of imageFiles) {
    const filename = path.basename(imagePath);
    const imageBuffer = await zip.file(imagePath).async('nodebuffer');
    await fs.writeFile(path.join(outputDir, filename), imageBuffer);
    
    // Store the extracted image path
    const relId = Object.keys(relationshipMap).find(key => relationshipMap[key] === filename);
    if (relId) {
      imageMap[relId] = filename;
    }
    
    console.log(`Extracted image: ${filename}`);
  }
  
  return imageMap;
}

/**
 * Custom document transformer for mammoth
 * @param {Object} document - DOCX document object
 * @returns {Object} - Transformed document
 */
function transformDocument(document) {
  return document;
}

/**
 * Turn Mammoth-generated footnotes into superscript tooltip format
 * @param {Object} $ - Cheerio document
 */
function transformFootnotes($) {
  // For every <sup><a href="#some-id">n</a></sup>…
  $('sup > a[href^="#"]').each((_, a) => {
    const $a = $(a);
    const targetId = $a.attr('href').slice(1);          // strip leading "#"
    const number = $a.text().trim();                    // visible footnote mark

    // The footnote text lives in the matching <li> (or any element) with that ID
    const $footnote = $(`*[id="${targetId}"]`);
    if (!$footnote.length) return;                       // safety check

    const text = $footnote.text().trim()
                          .replace(/^\s*\d+\s*/, '');   // drop leading number

    // Create superscript tooltip format
    const tooltip = `<sup class="footnote">${number}<span class="footnote-tooltip">${text}</span></sup>`;
    $a.closest('sup').replaceWith(tooltip);

    // Remove the original list item (so it doesn't appear at the bottom)
    $footnote.remove();
  });

  /* Clean-up: delete any empty <ol>/<div> that held the footnotes */
  $('ol, div').each((_, el) => {
    const $el = $(el);
    if (!$el.children().length && !$el.text().trim()) {
      $el.remove();
    }
  });
}

/**
 * Remove leftover "nFnF" artifacts that Word inserts as control markers.
 * Examples: 5F5F, 5F5F[6], 123F123F[42]
 * @param {CheerioAPI} $ – parsed HTML
 */
function cleanupArtifacts($) {
  const pattern = /(\d+)F\1F(?:\[\d+\])?/g; // with OR without "[m]"
  
  $('*').contents().each(function () {
    if (this.type !== 'text') return; // only text nodes
    
    const original = $(this).text();
    const cleaned = original.replace(pattern, '');
    
    if (cleaned !== original) {
      $(this).replaceWith(cleaned); // swap in-place only when needed
    }
  });
}

/**
 * Extract document structure from HTML
 * @param {Object} $ - Cheerio document
 * @returns {Object} - Document structure
 */
function extractDocumentStructure($) {
  const structure = {
    title: $('title').text() || 'Novel',
    frontMatter: [],
    books: [],
    chapters: [],
    appendices: []
  };
  
  // Find book and chapter structure
  let currentBook = null;
  let inFrontMatter = true;
  
  $('h1, h2, h3, p').each((i, el) => {
    const text = $(el).text().trim();
    
    // Check for appendix headings FIRST (so they don't get caught as chapters)
    if ($(el).is('h1, h2') && /appendix|one pagers|persons of interest|charts, maps/i.test(text)) {
      // New appendix found
      inFrontMatter = false;
      
      // Create appendix object with a more specific ID
      const appendixId = text.toLowerCase().replace(/[\s,]/g, '-').replace(/[^\w-]/g, '');
      const appendix = {
        title: text,
        id: `appendix-${appendixId}`,
        content: []
      };
      
      structure.appendices.push(appendix);
      return;
    }
    
    // Check for chapter titles (more flexible pattern matching)
    if ($(el).is('h1, h2') && /chapter\s+\w+/i.test(text)) {
      // New chapter found
      inFrontMatter = false;
      
      // Extract chapter number/name in a more reliable way
      let chapterNum = '';
      if (/chapter\s+(\w+(?:-\w+)?)/i.test(text)) {
        chapterNum = text.match(/chapter\s+(\w+(?:-\w+)?)/i)[1];
      } else {
        chapterNum = text.replace(/chapter\s+/i, '').trim();
      }
      
      // Create a more reliable ID for chapters including "twenty-one" style names
      const chapterId = `chapter-${chapterNum.toLowerCase().replace(/\s+/g, '-')}`;
      
      // Check if there's a number or ID in brackets
      let referenceId = '';
      const idMatch = $(el).html().match(/\[(\d+)\]/);
      if (idMatch) {
        referenceId = idMatch[1];
      }
      
      // Create chapter object
      const chapter = {
        title: text,
        id: chapterId,
        numericId: chapterNum,
        referenceId: referenceId,
        content: []
      };
      
      structure.chapters.push(chapter);
      
      // If we haven't assigned to a book yet, create a default book
      if (structure.books.length === 0) {
        currentBook = {
          title: 'Book One',
          chapters: []
        };
        structure.books.push(currentBook);
      }
      
      if (currentBook) {
        currentBook.chapters.push(chapter);
      }
      
      return;
    }
    
    // Check for book titles
    if ($(el).is('h1') && /book\s+\w+/i.test(text)) {
      // New book found
      inFrontMatter = false;
      
      // Create book object
      currentBook = {
        title: text,
        chapters: []
      };
      
      structure.books.push(currentBook);
      return;
    }
    
    // Add content to appropriate section
    if (inFrontMatter) {
      structure.frontMatter.push({
        type: $(el).prop('tagName').toLowerCase(),
        html: $(el).html()
      });
    } else if (structure.appendices.length > 0 && structure.chapters.length === 0) {
      // If we've seen appendices but no chapters yet, add to the last appendix
      const currentAppendix = structure.appendices[structure.appendices.length - 1];
      currentAppendix.content.push({
        type: $(el).prop('tagName').toLowerCase(),
        html: $(el).html()
      });
    } else if (structure.appendices.length > 0) {
      // If we have both chapters and appendices, check if we're in an appendix section
      // This helps when appendices are mixed with chapter content
      const lastEl = $(el).prev();
      let inAppendixSection = false;
      
      if (lastEl.length) {
        const lastText = lastEl.text().trim();
        if (/appendix|one pagers|persons of interest|charts, maps/i.test(lastText)) {
          inAppendixSection = true;
        }
      }
      
      if (inAppendixSection) {
        const currentAppendix = structure.appendices[structure.appendices.length - 1];
        currentAppendix.content.push({
          type: $(el).prop('tagName').toLowerCase(),
          html: $(el).html()
        });
      } else if (structure.chapters.length > 0) {
        const currentChapter = structure.chapters[structure.chapters.length - 1];
        currentChapter.content.push({
          type: $(el).prop('tagName').toLowerCase(),
          html: $(el).html()
        });
      }
    } else if (structure.chapters.length > 0) {
      const currentChapter = structure.chapters[structure.chapters.length - 1];
      currentChapter.content.push({
        type: $(el).prop('tagName').toLowerCase(),
        html: $(el).html()
      });
    }
  });
  
  return structure;
}

/**
 * Generate HTML files for all content
 * @param {Object} structure - Document structure
 * @param {Object} $ - Cheerio document
 * @param {string} outputDir - Output directory
 * @param {Object} imageMap - Image relationship map
 */
async function generateHtmlFiles(structure, $, outputDir, imageMap) {
  // Generate index.html (front matter)
  await generateFrontMatterHtml(structure, outputDir);
  
  // Generate chapter pages
  for (let i = 0; i < structure.chapters.length; i++) {
    const chapter = structure.chapters[i];
    const prevChapter = i > 0 ? structure.chapters[i - 1] : null;
    const nextChapter = i < structure.chapters.length - 1 ? structure.chapters[i + 1] : null;
    
    await generateChapterHtml(chapter, structure, outputDir, imageMap, prevChapter, nextChapter);
  }
  
  // Generate appendix pages
  for (let i = 0; i < structure.appendices.length; i++) {
    const appendix = structure.appendices[i];
    const prevAppendix = i > 0 ? structure.appendices[i - 1] : null;
    const nextAppendix = i < structure.appendices.length - 1 ? structure.appendices[i + 1] : null;
    
    await generateAppendixHtml(appendix, structure, outputDir, imageMap, prevAppendix, nextAppendix);
  }
}

/**
 * Generate front matter HTML
 * @param {Object} structure - Document structure
 * @param {string} outputDir - Output directory
 */
async function generateFrontMatterHtml(structure, outputDir) {
  let contentHtml = '<div class="front-matter">';
  
  // Process front matter with better spacing
  for (const item of structure.frontMatter) {
    if (item.type === 'h1' || item.type === 'h2' || item.type === 'h3') {
      contentHtml += `<${item.type} class="front-matter-heading">${item.html}</${item.type}>`;
    } else {
      // Add a front-matter-item class for better styling
      contentHtml += `<p class="front-matter-item">${item.html}</p>`;
    }
  }
  
  contentHtml += '</div>';
  
  const html = generateHtmlTemplate({
    title: structure.title,
    content: contentHtml,
    structure: structure,
    nav: {
      next: structure.chapters.length > 0 ? `chapters/${structure.chapters[0].id}.html` : null
    }
  });
  
  await fs.writeFile(path.join(outputDir, 'index.html'), html);
  console.log(`Generated front matter file`);
}

/**
 * Generate chapter HTML
 * @param {Object} chapter - Chapter object
 * @param {Object} structure - Document structure
 * @param {string} outputDir - Output directory
 * @param {Object} imageMap - Image relationship map
 * @param {Object} prevChapter - Previous chapter
 * @param {Object} nextChapter - Next chapter
 */
async function generateChapterHtml(chapter, structure, outputDir, imageMap, prevChapter, nextChapter) {
  // Add the reference ID to the title if it exists
  let titleHtml = chapter.title;
  
  let contentHtml = `<h1 class="chapter-title">${titleHtml}</h1>`;
  
  // Process chapter content
  for (const item of chapter.content) {
    // Process potential image references
    let processedHtml = processImageReferences(item.html, imageMap);
    
    if (item.type === 'h2' || item.type === 'h3') {
      contentHtml += `<${item.type} class="chapter-heading">${processedHtml}</${item.type}>`;
    } else {
      contentHtml += `<p>${processedHtml}</p>`;
    }
  }
  
  // Process computer UI text - removing this as requested
  // contentHtml = processComputerUI(contentHtml);
  
  const html = generateHtmlTemplate({
    title: `${chapter.title} - ${structure.title}`,
    content: contentHtml,
    structure: structure,
    currentChapter: chapter,
    nav: {
      prev: prevChapter ? `${prevChapter.id}.html` : '../index.html',
      next: nextChapter ? `${nextChapter.id}.html` : 
        (structure.appendices.length > 0 ? `../appendices/${structure.appendices[0].id}.html` : '../index.html')
    }
  });
  
  await fs.writeFile(path.join(outputDir, 'chapters', `${chapter.id}.html`), html);
  console.log(`Generated chapter file: ${chapter.id}.html`);
}

/**
 * Generate appendix HTML
 * @param {Object} appendix - Appendix object
 * @param {Object} structure - Document structure
 * @param {string} outputDir - Output directory
 * @param {Object} imageMap - Image relationship map
 * @param {Object} prevAppendix - Previous appendix
 * @param {Object} nextAppendix - Next appendix
 */
async function generateAppendixHtml(appendix, structure, outputDir, imageMap, prevAppendix, nextAppendix) {
  let contentHtml = `<h1 class="appendix-title">${appendix.title}</h1>`;
  
  // Process appendix content
  for (const item of appendix.content) {
    // Process potential image references
    let processedHtml = processImageReferences(item.html, imageMap);
    
    if (item.type === 'h2' || item.type === 'h3') {
      contentHtml += `<${item.type} class="appendix-heading">${processedHtml}</${item.type}>`;
    } else {
      contentHtml += `<p>${processedHtml}</p>`;
    }
  }
  
  // Determine navigation links
  const lastChapter = structure.chapters[structure.chapters.length - 1];
  
  const html = generateHtmlTemplate({
    title: `${appendix.title} - ${structure.title}`,
    content: contentHtml,
    structure: structure,
    currentAppendix: appendix,
    nav: {
      prev: prevAppendix ? `${prevAppendix.id}.html` : 
        (lastChapter ? `../chapters/${lastChapter.id}.html` : '../index.html'),
      next: nextAppendix ? `${nextAppendix.id}.html` : '../index.html'
    }
  });
  
  await fs.writeFile(path.join(outputDir, 'appendices', `${appendix.id}.html`), html);
  console.log(`Generated appendix file: ${appendix.id}.html`);
}

/**
 * Process image references in content
 * @param {string} html - HTML content
 * @param {Object} imageMap - Image relationship map
 * @returns {string} - Processed HTML
 */
function processImageReferences(html, imageMap) {
  let processedHtml = html;
  
  // Replace image references with proper image tags
  if (imageMap) {
    const imageRegex = /rId(\d+)/g;
    let match;
    while ((match = imageRegex.exec(html)) !== null) {
      const imageId = `rId${match[1]}`;
      if (imageMap[imageId]) {
        processedHtml = processedHtml.replace(
          new RegExp(escapeRegExp(imageId), 'g'),
          `<img src="../images/${imageMap[imageId]}" class="novel-image" alt="Novel illustration" data-original-id="${imageId}">`
        );
      }
    }
  }
  
  return processedHtml;
}

/**
 * Helper function to escape special characters in strings for use in RegExp
 * @param {string} string - String to escape
 * @returns {string} - Escaped string
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate HTML template for a page
 * @param {Object} options - Template options
 * @returns {string} - HTML template
 */
function generateHtmlTemplate(options) {
  const { title, content, structure, currentChapter, currentAppendix, nav = {} } = options;
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="${currentChapter || currentAppendix ? '../' : ''}css/style.css">
  <script src="${currentChapter || currentAppendix ? '../' : ''}js/main.js" defer></script>
</head>
<body data-theme="light">
  <button class="menu-toggle" aria-label="Toggle navigation">☰</button>
  <button class="theme-toggle" aria-label="Toggle dark mode">🌓</button>
  
  <div class="container">
    <!-- Sidebar with navigation -->
    <nav class="sidebar">
      <h2>Contents</h2>
      
      <!-- Home link -->
      <div class="nav-group">
        <ul class="nav-list">
          <li class="nav-item ${!currentChapter && !currentAppendix ? 'active' : ''}">
            <a href="${currentChapter || currentAppendix ? '../' : ''}index.html">Home</a>
          </li>
        </ul>
      </div>
      
      <!-- Chapters -->
      <div class="nav-group">
        <span class="nav-title">Chapters</span>
        <ul class="nav-list">
          ${structure.chapters.map(chapter => `
            <li class="nav-item ${currentChapter && currentChapter.id === chapter.id ? 'active' : ''}">
              <a href="${currentChapter || currentAppendix ? '../' : ''}chapters/${chapter.id}.html">${chapter.title}</a>
            </li>
          `).join('')}
        </ul>
      </div>
      
      <!-- Appendices -->
      ${structure.appendices.length > 0 ? `
        <div class="nav-group">
          <span class="nav-title">Appendices</span>
          <ul class="nav-list">
            ${structure.appendices.map(appendix => `
              <li class="nav-item ${currentAppendix && currentAppendix.id === appendix.id ? 'active' : ''}">
                <a href="${currentChapter || currentAppendix ? '../' : ''}appendices/${appendix.id}.html">${appendix.title}</a>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}
    </nav>
    
    <!-- Main content -->
    <main class="content">
      ${content}
      
      <!-- Chapter navigation -->
      ${nav.prev || nav.next ? `
        <div class="chapter-navigation">
          ${nav.prev ? `<a href="${nav.prev}" class="nav-prev">← Previous</a>` : '<span></span>'}
          <a href="${currentChapter || currentAppendix ? '../' : ''}index.html" class="nav-home">Home</a>
          ${nav.next ? `<a href="${nav.next}" class="nav-next">Next →</a>` : '<span></span>'}
        </div>
      ` : ''}
    </main>
  </div>
  
  <!-- Image overlay for fullscreen -->
  <div class="image-overlay"></div>
</body>
</html>`;
}

/**
 * Create template CSS and JS files
 * @param {string} outputDir - Output directory
 */
async function createTemplateFiles(outputDir) {
  // Create CSS file
  const cssContent = `
:root {
  --bg-color: #ffffff;
  --text-color: #333333;
  --accent-color: #3f51b5;
  --ui-bg-color: #f0f0f0;
  --sidebar-bg: #f4f4f4;
  --border-color: #ddd;
}

[data-theme="dark"] {
  --bg-color: #222222;
  --text-color: #e0e0e0;
  --accent-color: #7986cb;
  --ui-bg-color: #333333;
  --sidebar-bg: #1e1e1e;
  --border-color: #444;
}

/* Base styles */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Georgia', serif;
  line-height: 1.6;
  color: var(--text-color);
  background-color: var(--bg-color);
  transition: background-color 0.3s, color 0.3s;
}

.container {
  display: flex;
  min-height: 100vh;
}

/* Sidebar styles */
.sidebar {
  width: 260px;
  background-color: var(--sidebar-bg);
  padding: 20px;
  position: fixed;
  height: 100vh;
  overflow-y: auto;
  z-index: 100;
  transition: transform 0.3s ease;
  border-right: 1px solid var(--border-color);
}

.sidebar h2 {
  margin-top: 0;
  margin-bottom: 20px;
  color: var(--accent-color);
}

.nav-group {
  margin-bottom: 20px;
}

.nav-title {
  font-weight: bold;
  display: block;
  margin-bottom: 10px;
  color: var(--accent-color);
}

.nav-list {
  list-style: none;
  padding-left: 10px;
}

.nav-item {
  margin-bottom: 5px;
}

.nav-item a {
  text-decoration: none;
  color: var(--text-color);
  display: block;
  padding: 5px 0;
  transition: color 0.2s;
}

.nav-item a:hover {
  color: var(--accent-color);
}

.nav-item.active a {
  font-weight: bold;
  color: var(--accent-color);
}

/* Content styles */
.content {
  flex: 1;
  padding: 40px;
  margin-left: 260px;
  max-width: 800px;
}

/* Enhanced heading styles */
h1, h2, h3 {
  margin-bottom: 25px;
  color: var(--accent-color);
  line-height: 1.3;
}

h1 {
  font-size: 2.5em;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 15px;
}

h2 {
  font-size: 1.8em;
}

h3 {
  font-size: 1.5em;
}

/* Chapter-specific styles */
.chapter-title {
  font-size: 2.8em;
  text-align: center;
  margin-bottom: 40px;
}

.chapter-heading, .appendix-heading {
  font-size: 2em;
  margin-top: 30px;
}

.appendix-title {
  font-size: 2.8em;
  text-align: center;
  margin-bottom: 40px;
}

/* Front matter styling */
.front-matter {
  margin-bottom: 40px;
}

.front-matter-heading {
  font-size: 2.5em;
  margin-top: 40px;
  margin-bottom: 20px;
  text-align: center;
}

.front-matter-item {
  margin-bottom: 25px;
  font-size: 1.1em;
}

p {
  margin-bottom: 1.5em;
}

/* Footnotes - Superscript style */
.footnote {
  position: relative;
  cursor: pointer;
  color: var(--accent-color);
  vertical-align: super;
  font-size: 0.75em;
  font-weight: bold;
  padding: 0 2px;
}

.footnote-tooltip {
  position: absolute;
  bottom: 125%;
  left: 50%;
  transform: translateX(-50%) scale(0.95);
  width: 300px;
  max-width: 90vw;
  background-color: rgba(245, 245, 245, 0.97);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  padding: 12px 15px;
  border-radius: 6px;
  font-size: 1.1rem;
  line-height: 1.5;
  text-align: left;
  opacity: 0;
  visibility: hidden;
  transition: all 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  z-index: 1000;
  pointer-events: none;
  font-weight: normal;
  color: var(--text-color);
}

.footnote:hover .footnote-tooltip {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) scale(1);
}

/* Arrow at the bottom of tooltip */
.footnote-tooltip::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  margin-left: -8px;
  border-width: 8px;
  border-style: solid;
  border-color: rgba(245, 245, 245, 0.97) transparent transparent transparent;
}

[data-theme="dark"] .footnote-tooltip {
  background-color: rgba(45, 45, 45, 0.97);
}

[data-theme="dark"] .footnote-tooltip::after {
  border-color: rgba(45, 45, 45, 0.97) transparent transparent transparent;
}

/* Images */
.novel-image {
  max-width: 100%;
  height: auto;
  margin: 20px 0;
  display: block;
  cursor: pointer;
  transition: transform 0.3s ease;
}

.novel-image.expanded {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(0deg) scale(1);
  max-width: 90vw;
  max-height: 90vh;
  z-index: 1000;
  cursor: zoom-out;
  box-shadow: 0 0 50px rgba(0, 0, 0, 0.5);
}

.image-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.8);
  z-index: 999;
  display: none;
}

.image-overlay.active {
  display: block;
}

/* Navigation */
.chapter-navigation {
  display: flex;
  justify-content: space-between;
  margin-top: 60px;
  padding-top: 20px;
  border-top: 1px solid var(--border-color);
}

.nav-prev, .nav-next, .nav-home {
  text-decoration: none;
  color: white;
  background-color: var(--accent-color);
  padding: 10px 20px;
  border-radius: 4px;
  transition: background-color 0.2s;
  font-weight: bold;
}

.nav-prev:hover, .nav-next:hover, .nav-home:hover {
  background-color: var(--text-color);
}

/* Buttons */
.menu-toggle, .theme-toggle {
  position: fixed;
  z-index: 200;
  background-color: var(--accent-color);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 8px 12px;
  cursor: pointer;
}

.menu-toggle {
  top: 20px;
  left: 20px;
  display: none;
}

.theme-toggle {
  top: 20px;
  right: 20px;
}

/* Responsive design */
@media (max-width: 768px) {
  .sidebar {
    transform: translateX(-100%);
  }
  
  .sidebar.active {
    transform: translateX(0);
  }
  
  .content {
    margin-left: 0;
    padding: 20px;
  }
  
  .menu-toggle {
    display: block;
  }
  
  .footnote-tooltip {
    width: calc(100vw - 40px);
    left: 20px;
    transform: translateX(0) scale(0.95);
  }
  
  .footnote:hover .footnote-tooltip {
    transform: translateX(0) scale(1);
  }
  
  h1 {
    font-size: 2em;
  }
  
  .chapter-title, .appendix-title {
    font-size: 2.2em;
  }
}
`;
  
  await fs.writeFile(path.join(outputDir, 'css', 'style.css'), cssContent);
  
  // Create JS file
  const jsContent = `
// Wait for DOM content to be loaded
document.addEventListener('DOMContentLoaded', function() {
  // Initialize sidebar toggle
  initSidebarToggle();
  
  // Initialize theme toggle
  initThemeToggle();
  
  // Initialize image handling
  initImageHandling();
});

// Initialize sidebar toggle functionality
function initSidebarToggle() {
  const menuToggle = document.querySelector('.menu-toggle');
  const sidebar = document.querySelector('.sidebar');
  
  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', function() {
      sidebar.classList.toggle('active');
    });
    
    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', function(event) {
      if (window.innerWidth <= 768 && 
          !sidebar.contains(event.target) && 
          event.target !== menuToggle) {
        sidebar.classList.remove('active');
      }
    });
  }
}

// Initialize theme toggle functionality
function initThemeToggle() {
  const themeToggle = document.querySelector('.theme-toggle');
  
  if (themeToggle) {
    // Check for saved theme preference
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      document.body.setAttribute('data-theme', savedTheme);
    }
    
    // Toggle theme on button click
    themeToggle.addEventListener('click', function() {
      const currentTheme = document.body.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      
      document.body.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
    });
  }
}

// Initialize image handling functionality
function initImageHandling() {
  const images = document.querySelectorAll('.novel-image');
  const imageOverlay = document.querySelector('.image-overlay');
  
  if (images.length > 0 && imageOverlay) {
    images.forEach(image => {
      // Add click handler to expand/rotate images
      image.addEventListener('click', function() {
        this.classList.toggle('expanded');
        imageOverlay.classList.toggle('active');
      });
    });
    
    // Add click handler to close expanded images
    imageOverlay.addEventListener('click', function() {
      const expandedImage = document.querySelector('.novel-image.expanded');
      if (expandedImage) {
        expandedImage.classList.remove('expanded');
        imageOverlay.classList.remove('active');
      }
    });
  }
}
`;
  
  await fs.writeFile(path.join(outputDir, 'js', 'main.js'), jsContent);
}

// Export the main function
module.exports = { convertNovelToWebsite };

// If this script is run directly
if (require.main === module) {
  // Get command line arguments
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node convert-novel.js <input-docx> <output-dir>');
    process.exit(1);
  }
  
  const [inputDocx, outputDir] = args;
  
  // Run the conversion
  convertNovelToWebsite(inputDocx, outputDir)
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}
