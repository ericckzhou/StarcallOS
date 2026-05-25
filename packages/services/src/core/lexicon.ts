// Lexicons that drive deterministic concept quality scoring + filtering.
// All terms compared against the candidate's normalized lowercase form.
// Treat this file as DATA — edit the lists freely; bump PARSER_VERSION
// when behavior changes meaningfully.

// ─── Domain terms ────────────────────────────────────────────────────────────
// A candidate that contains or appears near any of these in evidence quotes
// gets a "domain term" boost. Tuned for ML/AI engineering books; extend
// per-source down the line if multi-domain support is needed.

export const DOMAIN_TERMS = new Set<string>([
  // Modeling
  'model', 'models', 'modeling', 'architecture', 'transformer', 'transformers',
  'neural', 'network', 'networks', 'layer', 'layers', 'attention',
  'parameter', 'parameters', 'weight', 'weights', 'gradient', 'gradients',
  // Training
  'training', 'trained', 'pretraining', 'finetune', 'finetuning', 'finetuned',
  'optimization', 'optimizer', 'loss', 'objective', 'backpropagation',
  'epoch', 'batch', 'dataset', 'datasets',
  // Inference / serving
  'inference', 'serving', 'latency', 'throughput', 'quantization', 'distillation',
  'pruning', 'caching', 'streaming',
  // Evaluation
  'evaluation', 'metric', 'metrics', 'benchmark', 'benchmarks', 'accuracy',
  'precision', 'recall', 'perplexity', 'bleu', 'rouge',
  // Data
  'data', 'dataset', 'preprocessing', 'tokenization', 'tokenizer', 'token',
  'sampling', 'augmentation',
  // Generative AI specifics
  'prompt', 'prompting', 'completion', 'generation', 'embedding', 'embeddings',
  'retrieval', 'rag', 'agent', 'agents', 'tool', 'tools', 'context',
  'instruction', 'alignment', 'rlhf', 'reward', 'preference',
  // Systems
  'pipeline', 'orchestration', 'observability', 'monitoring', 'telemetry',
  'deployment', 'production',
]);

// ─── Generic single-word terms to reject as concept candidates ───────────────
// These are too broad to be useful learning targets even when they appear as
// headings or repeatedly. Filtered out before scoring.

export const GENERIC_BAD_TERMS = new Set<string>([
  'data', 'model', 'system', 'systems', 'question', 'questions',
  'writing', 'reading', 'thinking', 'learning',
  'this', 'that', 'these', 'those', 'some', 'many', 'most', 'all',
  'work', 'use', 'using', 'used',
  'something', 'anything', 'nothing',
  'people', 'person', 'user', 'users',
  'time', 'way', 'ways', 'thing', 'things',
  'part', 'parts', 'point', 'points',
  'note', 'notes', 'example', 'examples', 'detail', 'details',
  'general', 'specific', 'common', 'typical',
  'first', 'second', 'third', 'last', 'next', 'previous',
  'high', 'low', 'good', 'bad', 'better', 'best', 'worse', 'worst',
  'main', 'simple', 'complex',
]);

// ─── Connective / prose words that fragment candidates ───────────────────────
// A heading or term starting/ending with these is almost certainly a sentence
// fragment, not a concept name.

export const CONNECTIVE_PREFIXES = new Set<string>([
  'however', 'therefore', 'because', 'while', 'whereas', 'although',
  'though', 'unless', 'until', 'since', 'before', 'after',
  'when', 'where', 'whenever', 'wherever',
  'if', 'else', 'otherwise',
  'and', 'or', 'but', 'nor', 'yet', 'so',
  'thus', 'hence', 'moreover', 'furthermore', 'additionally',
  'first', 'second', 'finally', 'lastly',
]);

export const PROSE_TAIL_WORDS = new Set<string>([
  // Prepositions/conjunctions that should never end a concept name
  'to', 'from', 'with', 'of', 'and', 'or', 'for', 'in', 'by', 'on', 'at',
  'as', 'into', 'about', 'over', 'under', 'than', 'via',
  'the', 'a', 'an',
  'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those',
]);

export const PROSE_HEAD_WORDS = new Set<string>([
  // Articles / vague openers that mark a fragment when a heading starts with them
  'a', 'an',
  // "The Foo" is fine; don't blacklist plain "the" — too common in real titles
]);

// ─── Common person-name first names ──────────────────────────────────────────
// Tiny list — primary purpose is to penalize "Bob ... Alice ..." style author
// references that get picked up as capitalized phrases.

export const COMMON_NAMES = new Set<string>([
  'bob', 'alice', 'john', 'jane', 'mary', 'james', 'david', 'sarah', 'michael',
  'wang', 'chen', 'kim', 'lee', 'patel', 'smith', 'jones', 'brown',
  'jennifer', 'robert', 'william', 'linda', 'richard', 'thomas',
]);

// ─── Acronym aliases ─────────────────────────────────────────────────────────
// Maps acronym ↔ canonical expansion. Both forms normalize to the SAME
// canonical key, so "RAG" and "Retrieval-Augmented Generation" become one
// candidate. Add aliases lowercase + dash-free; normalization handles the rest.

export const ACRONYM_TO_EXPANSION: Record<string, string> = {
  rag:   'retrieval augmented generation',
  llm:   'large language model',
  llms:  'large language model',
  lm:    'language model',
  lms:   'language model',
  ml:    'machine learning',
  ai:    'artificial intelligence',
  nlp:   'natural language processing',
  nlu:   'natural language understanding',
  rl:    'reinforcement learning',
  rlhf:  'reinforcement learning from human feedback',
  sft:   'supervised finetuning',
  dpo:   'direct preference optimization',
  ppo:   'proximal policy optimization',
  cot:   'chain of thought',
  tpot:  'time per output token',
  ttft:  'time to first token',
  moe:   'mixture of experts',
  mha:   'multi head attention',
  mlp:   'multi layer perceptron',
  cnn:   'convolutional neural network',
  rnn:   'recurrent neural network',
  lstm:  'long short term memory',
  gru:   'gated recurrent unit',
  gan:   'generative adversarial network',
  vae:   'variational autoencoder',
  gpu:   'graphics processing unit',
  tpu:   'tensor processing unit',
  api:   'api',          // canonical
  apis:  'api',
  kv:    'key value',
};

// Reverse lookup: expansion → canonical. Built once at module load.
export const EXPANSION_TO_CANONICAL: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [acronym, expansion] of Object.entries(ACRONYM_TO_EXPANSION)) {
    // The expansion itself maps to its own canonical (same as acronym's target)
    m.set(expansion, expansion);
    m.set(acronym,   expansion);
  }
  return m;
})();
