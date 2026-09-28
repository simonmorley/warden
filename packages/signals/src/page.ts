import { Parser } from "htmlparser2";

type Attributes = Record<string, string>;

/** What one pass over the markup finds. Everything in it is attacker-written. */
export interface ParsedPage {
  readonly title: string;
  readonly forms: ReadonlyArray<{ readonly action: string | null }>;
  readonly inputs: readonly Attributes[];
  readonly scripts: readonly string[];
  readonly metas: readonly Attributes[];
  readonly iframes: readonly Attributes[];
  readonly images: readonly string[];
  readonly links: readonly Attributes[];
  readonly logoAlts: readonly string[];
  /** Visible and hidden text alike: an injected instruction can sit in either. */
  readonly text: readonly string[];
}

const NOT_TEXT = new Set(["script", "style", "noscript", "template", "svg"]);

export function parsePage(html: string): ParsedPage {
  let title = "";
  let inTitle = false;
  let hiddenDepth = 0;
  let script: string[] | null = null;

  const page = {
    forms: [] as Array<{ action: string | null }>,
    inputs: [] as Attributes[],
    scripts: [] as string[],
    metas: [] as Attributes[],
    iframes: [] as Attributes[],
    images: [] as string[],
    links: [] as Attributes[],
    logoAlts: [] as string[],
    text: [] as string[],
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (NOT_TEXT.has(name)) hiddenDepth++;
        switch (name) {
          case "title":
            inTitle = true;
            break;
          case "form":
            page.forms.push({ action: attributes["action"] ?? null });
            break;
          case "input":
          case "select":
          case "textarea":
            page.inputs.push(attributes);
            if (attributes["placeholder"]) page.text.push(attributes["placeholder"]);
            break;
          case "script":
            if (!attributes["src"]) script = [];
            break;
          case "meta":
            page.metas.push(attributes);
            break;
          case "iframe":
            page.iframes.push(attributes);
            break;
          case "img":
            if (attributes["src"]) page.images.push(attributes["src"]);
            if (attributes["alt"] && /logo/i.test(`${attributes["alt"]} ${attributes["src"] ?? ""} ${attributes["class"] ?? ""}`)) {
              page.logoAlts.push(attributes["alt"]);
            }
            break;
          case "link":
            page.links.push(attributes);
            break;
        }
      },
      ontext(text) {
        if (script) script.push(text);
        else if (inTitle) title += text;
        else if (hiddenDepth === 0) page.text.push(text);
      },
      onclosetag(name) {
        if (NOT_TEXT.has(name)) hiddenDepth = Math.max(0, hiddenDepth - 1);
        if (name === "title") inTitle = false;
        if (name === "script" && script) {
          page.scripts.push(script.join(""));
          script = null;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  return { title: title.trim(), ...page };
}
