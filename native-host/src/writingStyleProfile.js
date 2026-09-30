'use strict';

const { MAX_SECTION_EXAMPLE_CHARS, resolveExample, renderExample } = require('./writingStyleEvidence');

const SECTION_KEYS = new Set(['general', 'abstract', 'introduction', 'related-work', 'methods', 'results', 'discussion', 'proofs', 'conclusion']);
const DIMENSIONS = Object.freeze({
  voice: 'Voice and stance',
  syntax: 'Sentence construction',
  rhythm: 'Sentence and paragraph rhythm',
  diction: 'Word choice',
  transitions: 'Connections between ideas',
  explanation: 'Local explanation patterns'
});
const LANGUAGE_DIMENSIONS = new Set(['voice', 'syntax', 'rhythm', 'diction', 'transitions']);
const invalid = message => Object.assign(new Error(message), { code: 'writing_style_generation_invalid' });

function text(value, min, max, field) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw invalid(field + ' must contain ' + min + '-' + max + ' characters.');
  }
  return value.trim();
}

function identifier(value, field) {
  const id = text(value, 1, 40, field);
  if (!/^[a-z][a-z0-9-]*$/i.test(id)) throw invalid(field + ' must be a short letter-led identifier.');
  return id;
}

function validate(input, documents) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Return a writing-style profile object.');
  if (typeof input.insufficientEvidence === 'string' && input.insufficientEvidence.trim()) {
    throw Object.assign(new Error(input.insufficientEvidence.trim().slice(0, 500)), { code: 'writing_style_insufficient_evidence' });
  }
  if (Object.hasOwn(input, 'guide') || Object.hasOwn(input, 'domainNotes')) {
    throw invalid('Use expression traits and evidenceLimits. Do not return a general paper-writing guide or field-convention rules.');
  }
  const label = text(input.label, 3, 100, 'label').replace(/[\r\n]/g, ' ');
  const evidenceLimits = text(input.evidenceLimits, 20, 1200, 'evidenceLimits');
  if (!Array.isArray(input.traits) || input.traits.length < 3 || input.traits.length > 8) {
    throw invalid('Provide 3-8 supported expression traits, or report insufficientEvidence.');
  }
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 6) {
    throw invalid('Provide 1-6 section groups for locating evidence.');
  }

  const sections = [], sectionKeys = new Set(), examplesById = new Map(), quotes = new Set();
  for (const section of input.sections) {
    if (!section || !SECTION_KEYS.has(section.key) || sectionKeys.has(section.key)) {
      throw invalid('Evidence groups need unique supported section keys.');
    }
    if (Object.hasOwn(section, 'guidance')) {
      throw invalid('Section groups contain evidence only. Put expression observations in traits, not chapter-writing instructions.');
    }
    if (!Array.isArray(section.examples) || !section.examples.length || section.examples.length > 3) {
      throw invalid('Each evidence group needs 1-3 short examples.');
    }
    sectionKeys.add(section.key);
    const examples = section.examples.map(raw => {
      const id = identifier(raw?.id, 'example.id');
      if (examplesById.has(id)) throw invalid('Example identifiers must be unique across the profile.');
      const resolved = resolveExample(raw, documents);
      const quoteKey = resolved.sourceId + ':' + resolved.quote;
      if (quotes.has(quoteKey)) throw invalid('Reuse an existing example ID instead of duplicating the same passage.');
      quotes.add(quoteKey);
      const example = { ...resolved, id, sectionKey: section.key };
      examplesById.set(id, example);
      return example;
    });
    if (examples.reduce((sum, example) => sum + example.quote.length, 0) > MAX_SECTION_EXAMPLE_CHARS) {
      throw invalid('An evidence group may contain at most ' + MAX_SECTION_EXAMPLE_CHARS + ' quoted characters.');
    }
    sections.push({
      key: section.key,
      title: text(section.title || section.key, 1, 120, 'section.title').replace(/[\r\n]/g, ' '),
      examples
    });
  }

  const ids = new Set(), usedExamples = new Set(), dimensions = new Set(), counts = new Map();
  const traits = input.traits.map(raw => {
    if (!raw || !Object.hasOwn(DIMENSIONS, raw.dimension)) throw invalid('Choose a supported language-style dimension.');
    const id = identifier(raw.id, 'trait.id');
    if (ids.has(id)) throw invalid('Style trait identifiers must be unique.');
    ids.add(id);
    dimensions.add(raw.dimension);
    counts.set(raw.dimension, (counts.get(raw.dimension) || 0) + 1);
    if (counts.get(raw.dimension) > 2) throw invalid('Use at most two traits per dimension; merge overlapping observations.');
    if (!Array.isArray(raw.exampleIds) || !raw.exampleIds.length || raw.exampleIds.length > 4) {
      throw invalid('Each trait must cite 1-4 example IDs.');
    }
    const exampleIds = raw.exampleIds.map(value => identifier(value, 'trait.exampleIds'));
    if (new Set(exampleIds).size !== exampleIds.length || exampleIds.some(value => !examplesById.has(value))) {
      throw invalid('Trait evidence must refer to distinct example IDs that exist in this profile.');
    }
    exampleIds.forEach(value => usedExamples.add(value));
    const template = text(raw.template, 15, 500, 'trait.template');
    if (!/\[[^\]\r\n]{1,80}\]/.test(template)) {
      throw invalid('Show the expression pattern with bracketed slots for existing facts, without inserting source-specific research content.');
    }
    return {
      id, dimension: raw.dimension,
      title: text(raw.title, 3, 100, 'trait.title').replace(/[\r\n]/g, ' '),
      observation: text(raw.observation, 30, 700, 'trait.observation'),
      application: text(raw.application, 30, 600, 'trait.application'),
      template,
      limits: text(raw.limits, 15, 400, 'trait.limits'),
      exampleIds,
      sourceIds: [...new Set(exampleIds.map(value => examplesById.get(value).sourceId))]
    };
  });

  const languageDimensions = [...dimensions].filter(value => LANGUAGE_DIMENSIONS.has(value));
  const languageTraits = traits.filter(value => LANGUAGE_DIMENSIONS.has(value.dimension));
  if (dimensions.size < 3 || languageDimensions.length < 2 || languageTraits.length * 2 < traits.length) {
    throw invalid('Cover at least three style dimensions, including two language-level dimensions. At least half the traits must address voice, syntax, rhythm, diction, or transitions.');
  }
  if (usedExamples.size !== examplesById.size) throw invalid('Every source example must support a named style trait.');
  const citedSources = new Set(traits.flatMap(trait => trait.sourceIds));
  if (documents.length > 1 && citedSources.size < 2) {
    throw invalid('A multi-source style profile must use evidence from more than one source.');
  }
  const order = Object.keys(DIMENSIONS);
  traits.sort((a, b) => order.indexOf(a.dimension) - order.indexOf(b.dimension));
  return { label, evidenceLimits, traits, sections };
}

function renderGuide(profile) {
  const examples = new Map(profile.sections.flatMap(section => section.examples.map(example => [example.id, example])));
  let output = '# Writing style\n\n'
    + 'Apply the supported expression preferences below to the current content. Keep the requested language, facts, terminology, and document structure. '
    + 'Bracketed slots illustrate phrasing and must be filled only with content already supported by the current task.\n';
  for (const dimension of Object.keys(DIMENSIONS)) {
    const traits = profile.traits.filter(trait => trait.dimension === dimension);
    if (!traits.length) continue;
    output += '\n## ' + DIMENSIONS[dimension] + '\n';
    for (const trait of traits) {
      output += '\n### ' + trait.id + ': ' + trait.title + '\n\n'
        + 'Observed: ' + trait.observation + '\n\n'
        + 'Apply: ' + trait.application + '\n\n'
        + 'Expression pattern: ' + trait.template + '\n\n'
        + 'When to adapt or skip: ' + trait.limits + '\n\n'
        + 'Evidence: ' + trait.exampleIds.map(id => id + ' in references/' + examples.get(id).sectionKey + '.md').join('; ') + '.\n'
        + 'Support: ' + trait.sourceIds.length + ' reference source(s).'
        + (trait.sourceIds.length === 1 ? ' This is a local observation, not a consensus across the reference set.' : '') + '\n';
    }
  }
  return output + '\n## Evidence limits\n\n' + profile.evidenceLimits + '\n';
}

function renderSection(section, profile, documents) {
  const exampleIds = new Set(section.examples.map(example => example.id));
  const traits = profile.traits.filter(trait => trait.exampleIds.some(id => exampleIds.has(id)));
  let output = '# ' + section.title + ' - source examples\n\n'
    + 'This file is an evidence index. Its section label does not require the target paper to use the same structure, research objects, or argument.\n\n'
    + '## Expression traits illustrated\n\n'
    + traits.map(trait => '- ' + trait.id + ': ' + trait.title).join('\n')
    + '\n\nSee references/writing-style.md for each trait and its limits.\n\n## Read-only examples\n';
  for (const example of section.examples) {
    output += renderExample(example, documents.find(doc => doc.id === example.sourceId));
  }
  return output;
}

module.exports = { validate, renderGuide, renderSection };
