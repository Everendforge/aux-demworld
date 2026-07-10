import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function fail(message) {
  errors.push(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    fail(
      `${relativePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

function readYaml(relativePath) {
  try {
    return YAML.parse(read(relativePath));
  } catch (error) {
    fail(
      `${relativePath}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      [".git", "node_modules", "dist", "dist-demo", ".validation"].includes(
        entry.name,
      )
    )
      continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else result.push(absolute);
  }
  return result;
}

function parseFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    fail(`${path.relative(root, filePath)}: missing YAML frontmatter`);
    return undefined;
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    fail(`${path.relative(root, filePath)}: unterminated YAML frontmatter`);
    return undefined;
  }
  try {
    return YAML.parse(text.slice(4, end));
  } catch (error) {
    fail(
      `${path.relative(root, filePath)}: invalid frontmatter (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

function isFolderDescription(filePath) {
  const base = path.basename(filePath, ".md");
  return fs.existsSync(path.join(path.dirname(filePath), base));
}

const entityFiles = walk(root).filter((filePath) => {
  if (!filePath.endsWith(".md")) return false;
  const relative = path.relative(root, filePath);
  if (["README.md", "LICENSE.md", "aux-demworld.md"].includes(relative))
    return false;
  if (relative.startsWith(`.everend${path.sep}templates${path.sep}`))
    return false;
  return !isFolderDescription(filePath);
});

const entityIds = new Map();
for (const filePath of entityFiles) {
  const relative = path.relative(root, filePath);
  const frontmatter = parseFrontmatter(filePath);
  if (!frontmatter) continue;
  for (const field of ["id", "type", "name", "status"]) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) {
      fail(`${relative}: missing required string field '${field}'`);
    }
  }
  if (
    typeof frontmatter.id === "string" &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(frontmatter.id)
  ) {
    fail(`${relative}: invalid stable id '${frontmatter.id}'`);
  }
  if (frontmatter.id) {
    if (entityIds.has(frontmatter.id))
      fail(
        `${relative}: duplicate id '${frontmatter.id}' also used by ${entityIds.get(frontmatter.id)}`,
      );
    entityIds.set(frontmatter.id, relative);
  }
}

const taxonomy = readYaml(".everend/taxonomy.yaml");
if (
  taxonomy?.specVersion !== "0.1" ||
  !taxonomy.types ||
  typeof taxonomy.types !== "object"
) {
  fail(".everend/taxonomy.yaml: expected specVersion 0.1 and a types object");
}

const compendium = readYaml(".everend/compendium.yaml");
if (compendium?.specVersion !== "0.1")
  fail(".everend/compendium.yaml: expected specVersion 0.1");
if (
  !Array.isArray(compendium?.publication?.statuses) ||
  !compendium.publication.statuses.includes("canon")
) {
  fail(".everend/compendium.yaml: publication.statuses must include canon");
}

const universe = readJson(".everend/universe.json");
if (typeof universe?.name !== "string" || !universe.name.trim())
  fail(".everend/universe.json: missing universe name");

const manifestPath = ".everend/.pathbranching/manifest.json";
const manifest = readJson(manifestPath);
if (
  manifest?.version !== "0.2" ||
  !Array.isArray(manifest?.stories) ||
  manifest.stories.length === 0
) {
  fail(`${manifestPath}: expected a v0.2 manifest with at least one story`);
}

let storyCount = 0;
let sequenceCount = 0;
let eventCount = 0;
let branchCount = 0;
let finalCount = 0;

for (const entry of manifest?.stories ?? []) {
  storyCount += 1;
  const story = readJson(entry.path);
  if (!story) continue;
  if (
    story.storageVersion !== "0.2" ||
    story.storyId !== entry.id ||
    !Array.isArray(story.sequenceIds)
  ) {
    fail(`${entry.path}: invalid modular story metadata`);
    continue;
  }

  const canonIds = new Set((story.canonRefs ?? []).map((ref) => ref.id));
  for (const canonId of canonIds) {
    if (!entityIds.has(canonId))
      fail(`${entry.path}: canon ref '${canonId}' has no matching entity`);
  }

  const sequences = [];
  const events = new Map();
  const branches = new Map();
  for (const sequenceId of story.sequenceIds) {
    const slug = String(sequenceId)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const sequencePath = `.everend/.pathbranching/stories/${entry.id}/sequences/${slug}/sequence.json`;
    const wrapped = readJson(sequencePath);
    const sequence = wrapped?.sequence;
    if (
      !sequence ||
      sequence.id !== sequenceId ||
      !Array.isArray(sequence.eventIds)
    ) {
      fail(`${sequencePath}: invalid sequence`);
      continue;
    }
    sequences.push(sequence);
    sequenceCount += 1;

    for (const eventId of sequence.eventIds) {
      const eventSlug = String(eventId)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const eventPath = `.everend/.pathbranching/stories/${entry.id}/sequences/${slug}/events/${eventSlug}.json`;
      const event = readJson(eventPath)?.event;
      if (!event || event.id !== eventId) {
        fail(`${eventPath}: missing or invalid event '${eventId}'`);
        continue;
      }
      events.set(event.id, event);
      eventCount += 1;
      if (event.type === "final") finalCount += 1;
      for (const ref of event.canonRefs ?? []) {
        if (!canonIds.has(ref))
          fail(
            `${eventPath}: event canon ref '${ref}' is absent from story.canonRefs`,
          );
      }
    }

    for (const branchId of sequence.branchIds ?? []) {
      const branchSlug = String(branchId)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const branchPath = `.everend/.pathbranching/stories/${entry.id}/sequences/${slug}/branches/${branchSlug}.json`;
      const branch = readJson(branchPath)?.branch;
      if (
        !branch ||
        branch.id !== branchId ||
        !Array.isArray(branch.eventIds)
      ) {
        fail(`${branchPath}: missing or invalid branch '${branchId}'`);
        continue;
      }
      branches.set(branch.id, branch);
      branchCount += 1;
    }
  }

  const allEventIds = new Set(events.keys());
  for (const sequence of sequences) {
    if (!allEventIds.has(sequence.entryEventId))
      fail(
        `Sequence '${sequence.id}' has missing entry event '${sequence.entryEventId}'`,
      );
    for (const eventId of sequence.eventIds) {
      if (!allEventIds.has(eventId))
        fail(`Sequence '${sequence.id}' references missing event '${eventId}'`);
    }
    for (const branchId of sequence.branchIds ?? []) {
      if (!branches.has(branchId))
        fail(
          `Sequence '${sequence.id}' references missing branch '${branchId}'`,
        );
    }
  }

  for (const branch of branches.values()) {
    for (const eventId of branch.eventIds) {
      const event = events.get(eventId);
      if (!event)
        fail(`Branch '${branch.id}' references missing event '${eventId}'`);
      else if (event.branchRef !== branch.id)
        fail(
          `Event '${eventId}' and branch '${branch.id}' disagree about membership`,
        );
    }
  }

  for (const event of events.values()) {
    if (event.type === "final" && (event.transitions?.length ?? 0) > 0)
      fail(`Terminal event '${event.id}' must not have outgoing transitions`);
    if (
      event.branchRef &&
      !branches.get(event.branchRef)?.eventIds.includes(event.id)
    ) {
      fail(
        `Event '${event.id}' references branch '${event.branchRef}' without reciprocal membership`,
      );
    }
    for (const transition of event.transitions ?? []) {
      if (transition.from !== event.id)
        fail(
          `Transition '${transition.id}' has wrong source '${transition.from}'`,
        );
      if (!allEventIds.has(transition.to))
        fail(
          `Transition '${transition.id}' targets missing event '${transition.to}'`,
        );
    }
  }
}

if (finalCount < 5)
  fail(`Expected at least five terminal endings; found ${finalCount}`);

if (errors.length) {
  console.error(`Vault validation failed with ${errors.length} problem(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Vault validation passed: ${entityIds.size} entities, ${storyCount} story, ${sequenceCount} sequences, ${branchCount} branches, ${eventCount} events, ${finalCount} endings.`,
);
