import type { ProblemContent, Rubric, RubricKey } from './problem.js';

export const RUBRIC_VERSION = 'rubric.v2';

export const DEFAULT_RUBRIC_CATEGORIES: { key: RubricKey; label: string; max: number; description: string }[] = [
  {
    key: 'correctness',
    label: 'Functional correctness & requirement coverage',
    max: 25,
    description:
      'Implements the stated functional requirements with correct observable behaviour, including all-or-nothing (atomic) multi-step state changes. Judged from execution evidence where it exists, otherwise from qualified code inspection.',
  },
  {
    key: 'modeling',
    label: 'Object modeling & responsibility assignment',
    max: 20,
    description:
      'Entities and services map to the domain; each type has a clear, single purpose; behaviour lives with the data it needs.',
  },
  {
    key: 'principles',
    label: 'SOLID & design principles',
    max: 15,
    description:
      'SOLID (each principle judged where it applies) and core design principles: encapsulation, separation of concerns, DRY, KISS/YAGNI, composition over inheritance, Law of Demeter, fail-fast validation and immutability. Invariants are enforced in one place and dependencies point in sensible directions.',
  },
  {
    key: 'extensibility',
    label: 'Extensibility & appropriate abstraction',
    max: 15,
    description:
      'Likely changes named in the problem can be made locally. Design patterns are judged on fit to those change points (used well, misapplied or unnecessary), never by count; unnecessary indirection is not rewarded.',
  },
  {
    key: 'readability',
    label: 'Readability & code organization',
    max: 10,
    description: 'Naming, package layout, method size and flow make the design easy to follow.',
  },
  {
    key: 'edge_cases',
    label: 'Edge cases & error handling',
    max: 10,
    description: 'Invalid input, boundary conditions and failure paths are handled deliberately and visibly; a failure part-way through an operation leaves no partial state.',
  },
  {
    key: 'tests',
    label: 'Test quality & meaningful coverage',
    max: 5,
    description: 'Tests exercise the important behaviour and edge cases with clear assertions. Passing tests alone do not prove coverage.',
  },
];

export function buildRubric(guidance: ProblemContent['rubricGuidance']): Rubric {
  return {
    version: RUBRIC_VERSION,
    total: 100,
    categories: DEFAULT_RUBRIC_CATEGORIES.map((c) => ({ ...c, guidance: guidance[c.key] ?? '' })),
  };
}

export const RUBRIC_TOTAL = DEFAULT_RUBRIC_CATEGORIES.reduce((s, c) => s + c.max, 0);
