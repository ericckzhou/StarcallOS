import React from 'react';

const COMMANDS: Record<string, string> = {
  alpha: 'alpha',
  beta: 'beta',
  gamma: 'gamma',
  delta: 'delta',
  epsilon: 'epsilon',
  theta: 'theta',
  lambda: 'lambda',
  mu: 'mu',
  pi: 'pi',
  sigma: 'sigma',
  tau: 'tau',
  phi: 'phi',
  omega: 'omega',
  times: 'x',
  cdot: '*',
  le: '<=',
  ge: '>=',
  neq: '!=',
  approx: '~',
  infty: 'infinity',
  sum: 'sum',
  prod: 'prod',
};

interface Props {
  value: string;
  size?: number;
  color?: string;
}

export default function LatexMath({ value, size = 13, color = '#fde68a' }: Props) {
  const displayValue = normalizeLatex(value);
  return (
    <span
      title={value}
      style={{
        display: 'inline',
        color,
        fontFamily: 'Cambria Math, STIX Two Math, Times New Roman, serif',
        fontSize: size,
        lineHeight: 1.75,
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
      }}
    >
      {renderLatex(displayValue)}
    </span>
  );
}

function normalizeLatex(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(/\\left/g, '')
    .replace(/\\right/g, '')
    .replace(/\\,/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\text\s*\{/g, '\\text{')
    .trim();
}

function renderLatex(input: string): React.ReactNode[] {
  const parser = new Parser(input);
  return parser.parse();
}

class Parser {
  private i = 0;
  private key = 0;

  constructor(private readonly text: string) {}

  parse(stopAtGroup = false): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    while (this.i < this.text.length) {
      if (stopAtGroup && this.text[this.i] === '}') break;
      if (this.text[this.i] === '}') {
        this.i += 1;
        continue;
      }
      const atom = this.readAtom();
      out.push(this.readScripts(atom));
    }
    return out;
  }

  private readAtom(): React.ReactNode {
    const ch = this.text[this.i];
    if (ch === '\\') return this.readCommand();
    if (ch === '{') {
      this.i += 1;
      const grouped = this.parse(true);
      if (this.text[this.i] === '}') this.i += 1;
      return <span key={this.nextKey()}>{grouped}</span>;
    }
    return this.readPlain();
  }

  private readCommand(): React.ReactNode {
    this.i += 1;
    const start = this.i;
    while (/[A-Za-z]/.test(this.text[this.i] ?? '')) this.i += 1;
    const name = this.text.slice(start, this.i);

    if (name === 'frac') {
      const numerator = this.readRequiredGroup();
      const denominator = this.readRequiredGroup();
      return (
        <span key={this.nextKey()} style={{
          display: 'inline-block',
          verticalAlign: '-0.45em',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          margin: '0 0.18em',
          lineHeight: 1,
        }}>
          <span style={{ display: 'block', padding: '0 0.25em 1px' }}>{numerator}</span>
          <span style={{ display: 'block', borderTop: '1px solid currentColor', padding: '1px 0.25em 0' }}>{denominator}</span>
        </span>
      );
    }

    if (name === 'text') {
      const body = this.readRequiredGroupText();
      return (
        <span key={this.nextKey()} style={{ fontFamily: 'Inter, system-ui, sans-serif', fontStyle: 'normal', whiteSpace: 'pre-wrap' }}>
          {body}
        </span>
      );
    }

    const symbol = COMMANDS[name] ?? name;
    return <span key={this.nextKey()}>{symbol}</span>;
  }

  private readPlain(): React.ReactNode {
    const start = this.i;
    while (this.i < this.text.length && !['\\', '{', '}', '_', '^'].includes(this.text[this.i])) {
      this.i += 1;
    }
    const raw = this.text.slice(start, this.i);
    const proseLike = /\s/.test(raw) && /[A-Za-z]{3,}/.test(raw);
    return (
      <span key={this.nextKey()} style={{
        fontFamily: proseLike ? 'Inter, system-ui, sans-serif' : 'inherit',
        fontStyle: proseLike ? 'normal' : /[A-Za-z]/.test(raw) ? 'italic' : 'normal',
        whiteSpace: 'pre-wrap',
      }}>
        {raw}
      </span>
    );
  }

  private readScripts(base: React.ReactNode): React.ReactNode {
    let sub: React.ReactNode[] | null = null;
    let sup: React.ReactNode[] | null = null;

    while (this.text[this.i] === '_' || this.text[this.i] === '^') {
      const kind = this.text[this.i];
      this.i += 1;
      const script = this.readScriptValue();
      if (kind === '_') sub = script;
      else sup = script;
    }

    if (!sub && !sup) return base;
    return (
      <span key={this.nextKey()} style={{ display: 'inline', whiteSpace: 'nowrap' }}>
        {base}
        {sup && <sup style={{ fontSize: '0.7em', lineHeight: 0, verticalAlign: 'super' }}>{sup}</sup>}
        {sub && <sub style={{ fontSize: '0.7em', lineHeight: 0, verticalAlign: 'sub' }}>{sub}</sub>}
      </span>
    );
  }

  private readScriptValue(): React.ReactNode[] {
    if (this.text[this.i] === '{') {
      this.i += 1;
      const grouped = this.parse(true);
      if (this.text[this.i] === '}') this.i += 1;
      return grouped;
    }
    const atom = this.readAtom();
    if (this.text[this.i] === '}') {
      this.i += 1;
      return [atom, <span key={this.nextKey()}>{'}'}</span>];
    }
    return [atom];
  }

  private readRequiredGroup(): React.ReactNode[] {
    if (this.text[this.i] !== '{') return [this.readAtom()];
    this.i += 1;
    const grouped = this.parse(true);
    if (this.text[this.i] === '}') this.i += 1;
    return grouped;
  }

  private readRequiredGroupText(): string {
    if (this.text[this.i] !== '{') return '';
    this.i += 1;
    let depth = 1;
    const start = this.i;
    while (this.i < this.text.length && depth > 0) {
      if (this.text[this.i] === '{') depth += 1;
      if (this.text[this.i] === '}') depth -= 1;
      this.i += 1;
    }
    return this.text.slice(start, Math.max(start, this.i - 1));
  }

  private nextKey(): string {
    this.key += 1;
    return `m-${this.key}`;
  }
}
