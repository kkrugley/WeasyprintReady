// Файл: code.ts - Версия с исправлением ошибки типизации Set/Array

// Интерфейсы для хранения собранной информации
interface ExportedImage { name: string; bytes: string; }
interface UsedFont { family: string; style: string; weight: number; }
interface ProcessingContext {
  images: ExportedImage[];
  // ** THE FIX IS HERE **
  fonts: Set<UsedFont>; // Тип должен быть Set, чтобы метод .add() работал
  cssRules: Map<string, string[]>;
  classId: number;
}

// Запускаем UI
figma.showUI(__html__, { width: 400, height: 600 });

// Слушаем сообщения от UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'generate-template') {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1 || selection[0].type !== 'FRAME') {
      figma.ui.postMessage({ type: 'error', message: 'Пожалуйста, выберите один Frame.' });
      return;
    }

    // Создаем "контекст" для этого конкретного запуска
    const context: ProcessingContext = {
      images: [],
      fonts: new Set<UsedFont>(), // Используем Set для автоматической дедупликации
      cssRules: new Map(),
      classId: 0,
    };

    try {
      const rootNode = selection[0];
      const htmlContent = await processNode(rootNode, context);
      const finalCss = generateFinalCss(rootNode, context);

      figma.ui.postMessage({
        type: 'generation-result',
        payload: {
          html: htmlContent,
          css: finalCss,
          images: context.images,
          fonts: Array.from(context.fonts), // Конвертируем Set в массив перед отправкой в UI
          frameName: rootNode.name.replace(/[^a-zA-Z0-9]/g, '_') || 'export'
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        figma.ui.postMessage({ type: 'error', message: `Ошибка: ${error.message}` });
        console.error(error.stack);
      }
    }
  }
};

// Главная рекурсивная функция обработки узлов
async function processNode(node: SceneNode, context: ProcessingContext): Promise<string> {
  if (!node.visible) return '';

  const { name } = node;
  const parts = name.split('-').map(p => p.trim());
  const prefix = parts[0];
  const varName = parts.slice(1).join('_');

  // Обработка циклов {% for ... %}
  if (prefix === 'loop' && 'children' in node) {
    const loopVar = varName.endsWith('s') ? varName.slice(0, -1) : varName + '_item'; // 'products' -> 'product'
    let itemHtml = '';
    // Ищем ОДИН дочерний элемент, который будет шаблоном для цикла
    const templateNode = node.children.find(child => child.visible);
    if (templateNode) {
      itemHtml = await processNode(templateNode, context);
    }
    const className = generateCssForNode(node, context);
    return `<div class="${className}">\n  {% for ${loopVar} in ${varName} %}\n${itemHtml}\n  {% endfor %}\n</div>`;
  }
  
  // Стандартная обработка узла
  const className = generateCssForNode(node, context);
  let childrenHtml = '';
  if ('children' in node) {
    for (const child of node.children) {
      childrenHtml += await processNode(child, context);
    }
  }

  let tag = 'div';
  let content = childrenHtml;
  let attrs = `class="${className}"`;
  
  // Определяем тег и контент на основе типа узла
  if (node.type === 'TEXT') {
    tag = 'p'; // По умолчанию p, можно усложнить для h1,h2...
    content = prefix === 'var' ? `{{ ${varName} }}` : node.characters.replace(/\n/g, '<br>');
  } else if (isImageNode(node)) {
    tag = 'img';
    const exportedImageName = await exportImage(node, context);
    const src = prefix === 'var' ? `{{ ${varName} }}` : `images/${exportedImageName}`;
    attrs += ` src="${src}" alt="${varName || 'image'}"`;
    content = ''; // У img нет дочерних элементов
  }
  
  const html = `<${tag} ${attrs}>${content}</${tag}>`;
  
  // Обработка условий {% if ... %}
  if (prefix === 'if') {
    return `{% if ${varName} %}\n  ${html}\n{% endif %}`;
  }
  
  return html;
}

// Утилита для проверки, является ли узел изображением
function isImageNode(node: SceneNode): boolean {
  return 'fills' in node && Array.isArray(node.fills) && node.fills.some(fill => fill.type === 'IMAGE' && fill.visible);
}

// Утилита для экспорта изображения
async function exportImage(node: SceneNode, context: ProcessingContext): Promise<string> {
  const imageName = `image_${context.images.length + 1}.png`;
  try {
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
    context.images.push({ name: imageName, bytes: figma.base64Encode(bytes) });
  } catch (e) {
    console.error(`Failed to export image from node "${node.name}":`, e);
  }
  return imageName;
}

// Функция генерации CSS
function generateCssForNode(node: SceneNode, context: ProcessingContext): string {
  const styles: string[] = [];
  const className = `el-${context.classId++}`;

  // Стили Flexbox из Auto Layout
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    styles.push('display: flex;');
    styles.push(`flex-direction: ${node.layoutMode === 'VERTICAL' ? 'column' : 'row'};`);
    if (node.itemSpacing > 0) styles.push(`gap: ${node.itemSpacing}px;`);
    
    const justifyContentMap: { [key: string]: string } = { MIN: 'flex-start', MAX: 'flex-end', CENTER: 'center', SPACE_BETWEEN: 'space-between' };
    if (node.primaryAxisAlignItems in justifyContentMap) {
        styles.push(`justify-content: ${justifyContentMap[node.primaryAxisAlignItems]};`);
    }

    const alignItemsMap: { [key: string]: string } = { MIN: 'flex-start', MAX: 'flex-end', CENTER: 'center' };
    if (node.counterAxisAlignItems in alignItemsMap) {
      styles.push(`align-items: ${alignItemsMap[node.counterAxisAlignItems]};`);
    }
  }

  // Отступы
  if ('paddingLeft' in node) {
    styles.push(`padding: ${node.paddingTop}px ${node.paddingRight}px ${node.paddingBottom}px ${node.paddingLeft}px;`);
  }

  // Заливка
  if ('fills' in node && Array.isArray(node.fills)) {
    const solidFill = node.fills.find(fill => fill.type === 'SOLID' && fill.visible);
    if (solidFill) {
      const { r, g, b } = solidFill.color;
      const a = solidFill.opacity ?? 1;
      styles.push(`background-color: rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a.toFixed(2)});`);
    }
  }

  // Обводка
  if ('strokes' in node && node.strokes.length > 0) {
      const stroke = node.strokes[0];
      if (stroke.type === 'SOLID' && stroke.visible) {
          const { r, g, b } = stroke.color;
          const a = stroke.opacity ?? 1;
          const weight = typeof node.strokeWeight === 'number' ? node.strokeWeight : 1;
          styles.push(`border: ${weight}px solid rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a.toFixed(2)});`);
      }
  }
  
  // Скругление углов
  if ('cornerRadius' in node && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    styles.push(`border-radius: ${node.cornerRadius}px;`);
  }

  // Стили текста
  if (node.type === 'TEXT') {
    if (node.fontName !== figma.mixed) {
      const fontName = node.fontName;
      const fontWeightMap: { [key: string]: number } = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
      const styleKey = fontName.style.toLowerCase().replace(/ /g, '');
      const weight = fontWeightMap[styleKey] || 400;
      
      // Добавляем шрифт в общий список, Set сам разберется с дубликатами
      context.fonts.add({ family: fontName.family, style: fontName.style, weight });

      styles.push(`font-family: '${fontName.family}', sans-serif;`);
      styles.push(`font-weight: ${weight};`);
      if (fontName.style.toLowerCase().includes('italic')) {
        styles.push('font-style: italic;');
      }
    }
    if (node.fontSize !== figma.mixed) styles.push(`font-size: ${node.fontSize}px;`);
    if (node.fills !== figma.mixed && node.fills.length > 0) {
        const fill = node.fills[0];
        if (fill.type === 'SOLID') {
             const { r, g, b } = fill.color;
             styles.push(`color: rgb(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)});`);
        }
    }
    // ... другие стили текста (line-height, letter-spacing) можно добавить по аналогии
  }

  if (styles.length > 0) {
    context.cssRules.set(className, styles);
    return className;
  }
  return '';
}

// Финальная сборка CSS-файла
function generateFinalCss(rootNode: FrameNode, context: ProcessingContext): string {
    let cssString = `@charset "UTF-8";\n\n/* Generated by WeasyPrint Exporter */\n\n`;
    
    // Правило @page
    cssString += `@page {\n    size: ${rootNode.width}px ${rootNode.height}px;\n    margin: 0;\n}\n\n`;
    
    // Базовые стили
    cssString += `body { margin: 0; font-family: sans-serif; box-sizing: border-box; }\n`;
    cssString += `*, *::before, *::after { box-sizing: inherit; }\n`;
    cssString += `img { max-width: 100%; display: block; }\n\n`;

    // Подключение шрифтов
    const fonts = Array.from(context.fonts);
    if (fonts.length > 0) {
        cssString += `/* --- FONT DEFINITIONS --- */\n`;
        fonts.forEach(font => {
            cssString += `@font-face {\n`;
            cssString += `  font-family: '${font.family}';\n`;
            cssString += `  font-style: ${font.style.toLowerCase().includes('italic') ? 'italic' : 'normal'};\n`;
            cssString += `  font-weight: ${font.weight};\n`;
            // Генерируем "умное" имя файла
            const fileName = `${font.family.replace(/ /g, '')}-${font.style.replace(/ /g, '')}.ttf`;
            cssString += `  src: url('fonts/${fileName}');\n`;
            cssString += `}\n\n`;
        });
    }

    // Стили элементов
    cssString += `/* --- ELEMENT STYLES --- */\n`;
    for (const [className, rules] of context.cssRules.entries()) {
        cssString += `.${className} {\n`;
        rules.forEach(rule => { cssString += `    ${rule}\n`; });
        cssString += `}\n\n`;
    }
    return cssString;
}