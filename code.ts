// Файл: code.ts
// Финальная версия с исправлением ошибок типизации TS7053

figma.showUI(__html__, { width: 340, height: 500 });

const cssRules = new Map<string, string[]>();
let classId = 0;
const imagesToExport: { name: string; bytes: string }[] = [];
const usedFonts = new Set<string>();

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'generate-html') {
    const selection = figma.currentPage.selection;

    if (selection.length !== 1 || selection[0].type !== 'FRAME') {
      figma.ui.postMessage({ type: 'error', message: 'Пожалуйста, выберите один Frame.' });
      return;
    }

    const rootNode = selection[0];

    cssRules.clear();
    imagesToExport.length = 0;
    usedFonts.clear();
    classId = 0;

    try {
      const htmlContent = await processNode(rootNode);
      let finalCss = generateFinalCss(rootNode);
      const fonts = Array.from(usedFonts).map(fontString => {
          const [family, style] = fontString.split('::');
          return { family, style };
      });
      
      figma.ui.postMessage({
        type: 'generation-result',
        payload: {
          html: `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>{{ project_name }}</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    ${htmlContent}
</body>
</html>`,
          css: finalCss,
          images: imagesToExport,
          fonts: fonts,
          frameName: rootNode.name.replace(/[^a-zA-Z0-9]/g, '_') || 'export'
        },
      });

    } catch (error) {
      if (error instanceof Error) {
        console.error("Plugin Error:", error);
        figma.ui.postMessage({ type: 'error', message: `Произошла внутренняя ошибка: ${error.message}` });
      } else {
        console.error("Unknown Plugin Error:", error);
        figma.ui.postMessage({ type: 'error', message: `Произошла неизвестная внутренняя ошибка` });
      }
    }
  }
};

async function processNode(node: SceneNode): Promise<string> {
  if (!node.visible) return '';
  
  const nodeName = node.name.trim();
  const className = generateCssForNode(node);

  if (nodeName === '{{ project_name }}' && node.type === 'TEXT') {
    return `<h1 class="${className}">{{ project_name }}</h1>`;
  }
  if (nodeName === '{{ project_description }}' && node.type === 'TEXT') {
    return `<div class="${className}">{{ project_description | safe }}</div>`;
  }
  if (nodeName === '{{#images}}' && 'children' in node) {
    let imagesHtml = `{% for image_path in images %}\n    <div class="image-container">\n        <img src="{{ image_path }}" alt="Project image">\n    </div>\n{% endfor %}`;
    return `<div class="${className}">\n${imagesHtml}\n</div>`;
  }

  let childrenHtml = '';
  if ('children' in node) {
    for (const child of node.children) {
      childrenHtml += await processNode(child);
    }
  }

  let tagName = 'div';
  let content = childrenHtml;
  let extraAttrs = '';

  if (node.type === 'TEXT') {
    content = node.characters.replace(/\n/g, '<br>');
  } else if (
    node.type === 'RECTANGLE' || node.type === 'ELLIPSE' ||
    node.type === 'POLYGON' || node.type === 'VECTOR' || node.type === 'FRAME'
  ) {
    const imageFill = Array.isArray(node.fills) && node.fills.find(fill => fill.type === 'IMAGE' && fill.visible);
    if (imageFill) {
      try {
        const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
        const base64String = figma.base64Encode(bytes);
        const imageName = `image_${imagesToExport.length + 1}.png`;
        imagesToExport.push({ name: imageName, bytes: base64String });
        
        if (!('children' in node) || node.children.length === 0) {
           tagName = 'img';
           content = ''; 
           extraAttrs = ` src="images/${imageName}" alt="${node.name.replace(/"/g, '"')}"`;
        } else {
          const rules = cssRules.get(className) || [];
          rules.push(`background-image: url('images/${imageName}');`);
          rules.push(`background-size: cover;`);
          rules.push(`background-position: center;`);
          cssRules.set(className, rules);
        }
      } catch (e) {
        console.error(`Image export failed for node "${node.name}":`, e);
      }
    }
  }

  const classAttr = className ? ` class="${className}"` : '';

  if (tagName === 'img') {
      return `<${tagName}${classAttr}${extraAttrs}>`;
  }
  return `<${tagName}${classAttr}>${content}</${tagName}>`;
}

function generateCssForNode(node: SceneNode): string {
  const styles: string[] = [];
  const className = `el-${classId++}`;

  if ('opacity' in node && node.opacity < 1) styles.push(`opacity: ${node.opacity.toFixed(2)};`);
  
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    if (node.layoutMode !== 'NONE') {
      styles.push('display: flex;');
      styles.push(`flex-direction: ${node.layoutMode === 'VERTICAL' ? 'column' : 'row'};`);
      if (node.itemSpacing > 0) styles.push(`gap: ${node.itemSpacing}px;`);
      
      const justifyContentMap: { [key: string]: string } = { MIN: 'flex-start', MAX: 'flex-end', CENTER: 'center', SPACE_BETWEEN: 'space-between' };
      if (node.primaryAxisAlignItems in justifyContentMap) {
          styles.push(`justify-content: ${justifyContentMap[node.primaryAxisAlignItems]};`);
      }

      // ** THE REAL FIX 1 **
      const alignItemsMap: { [key: string]: string } = { MIN: 'flex-start', MAX: 'flex-end', CENTER: 'center' };
      if (node.counterAxisAlignItems in alignItemsMap) {
        styles.push(`align-items: ${alignItemsMap[node.counterAxisAlignItems]};`);
      }
      
      if (node.layoutWrap === 'WRAP') styles.push('flex-wrap: wrap;');
    }
    if (node.paddingTop > 0 || node.paddingRight > 0 || node.paddingBottom > 0 || node.paddingLeft > 0) {
      styles.push(`padding: ${node.paddingTop}px ${node.paddingRight}px ${node.paddingBottom}px ${node.paddingLeft}px;`);
    }
  }
  
  if ('fills' in node && Array.isArray(node.fills)) {
    const solidFill = node.fills.find(fill => fill.type === 'SOLID' && fill.visible);
    if (solidFill && solidFill.type === 'SOLID') {
      const { r, g, b } = solidFill.color;
      const a = solidFill.opacity ?? 1;
      styles.push(`background-color: rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a.toFixed(2)});`);
    }
  }

  if ('strokes' in node && node.strokes.length > 0) {
    const stroke = node.strokes[0];
    if (stroke.type === 'SOLID' && stroke.visible) {
      const { r, g, b } = stroke.color;
      const a = stroke.opacity ?? 1;
      const weight = typeof node.strokeWeight === 'number' ? node.strokeWeight : 1;
      styles.push(`border: ${weight}px solid rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a.toFixed(2)});`);
    }
  }

  if ('cornerRadius' in node && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    styles.push(`border-radius: ${node.cornerRadius}px;`);
  } else if ((node.type === 'RECTANGLE' || node.type === 'FRAME') && typeof node.topLeftRadius === 'number') {
    styles.push(`border-radius: ${node.topLeftRadius || 0}px ${node.topRightRadius || 0}px ${node.bottomRightRadius || 0}px ${node.bottomLeftRadius || 0}px;`);
  }

  if (node.type === 'TEXT') {
    if (node.fontName !== figma.mixed) {
      const fontName = node.fontName;
      usedFonts.add(`${fontName.family}::${fontName.style}`);
      styles.push(`font-family: '${fontName.family}', sans-serif;`);
      styles.push(`font-style: ${fontName.style.toLowerCase().includes('italic') ? 'italic' : 'normal'};`);
      
      const fontWeightMap: { [key: string]: number } = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
      const styleKey = fontName.style.toLowerCase().replace(/ /g, '');
      if (styleKey in fontWeightMap) {
        styles.push(`font-weight: ${fontWeightMap[styleKey]};`);
      } else {
        styles.push(`font-weight: 400;`);
      }
    }
    if (node.fontSize !== figma.mixed) styles.push(`font-size: ${node.fontSize}px;`);
    if (node.lineHeight !== figma.mixed && node.lineHeight.unit !== 'AUTO') {
      const value = node.lineHeight.unit === 'PIXELS' ? `${node.lineHeight.value}px` : `${node.lineHeight.value}%`;
      styles.push(`line-height: ${value};`);
    }
    if (node.letterSpacing !== figma.mixed && node.letterSpacing.value !== 0 && node.fontSize !== figma.mixed) {
      const value = node.letterSpacing.unit === 'PIXELS' ? `${node.letterSpacing.value}px` : `${(node.letterSpacing.value / node.fontSize).toFixed(3)}em`;
      styles.push(`letter-spacing: ${value};`);
    }
    if (node.textCase !== figma.mixed && node.textCase !== 'ORIGINAL') {
        // ** THE REAL FIX 2 **
        const textTransformMap: { [key: string]: string } = { 'UPPER': 'uppercase', 'LOWER': 'lowercase', 'TITLE': 'capitalize' };
        if (node.textCase in textTransformMap) {
          styles.push(`text-transform: ${textTransformMap[node.textCase]};`);
        }
    }
    if (node.textAlignHorizontal) styles.push(`text-align: ${node.textAlignHorizontal.toLowerCase()};`);
  }

  if ('effects' in node && node.effects.length > 0) {
    const shadow = node.effects.find(e => e.type === 'DROP_SHADOW' && e.visible);
    if (shadow && shadow.type === 'DROP_SHADOW') {
      const { r, g, b, a } = shadow.color;
      styles.push(`box-shadow: ${shadow.offset.x}px ${shadow.offset.y}px ${shadow.radius}px rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a.toFixed(2)});`);
    }
  }
  
  if (node.name.includes('[no-break]')) {
    styles.push('page-break-inside: avoid;');
  }

  if (styles.length > 0) {
    cssRules.set(className, styles);
    return className;
  }
  return '';
}

function generateFinalCss(rootNode: FrameNode): string {
    let cssString = `/* Generated by Figma to WeasyPrint Exporter */\n\n`;
    cssString += `@page {\n    size: ${rootNode.width}px ${rootNode.height}px;\n    margin: 0;\n}\n\n`;
    cssString += `body {\n    margin: 0;\n    font-family: sans-serif;\n    box-sizing: border-box;\n}\n\n`;
    cssString += `*, *::before, *::after {\n    box-sizing: inherit;\n}\n\n`;
    cssString += `img { max-width: 100%; height: auto; display: block; }\n\n`;
    cssString += `.image-container img { width: 100%; height: auto; }\n\n`;

    for (const [className, rules] of cssRules.entries()) {
        cssString += `.${className} {\n`;
        rules.forEach(rule => { cssString += `    ${rule}\n`; });
        cssString += `}\n\n`;
    }
    return cssString;
}