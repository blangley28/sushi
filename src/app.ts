#!/usr/bin/env node

import path from 'path';
import fs from 'fs-extra';
import program from 'commander';
import { importText, FSHTank, RawFSH } from './import';
import { exportFHIR } from './export';
import { IGExporter } from './ig/IGExporter';
import { logger, stats } from './utils/FSHLogger';
import { loadDependency } from './fhirdefs/load';
import { FHIRDefinitions } from './fhirdefs';

app();

async function app() {
  let input: string;

  program
    .name('sushi')
    .usage('<path-to-fsh-defs> [options]')
    .option('-o, --out <out>', 'the path to the output folder', path.join('.', 'build'))
    .option('-d, --debug', 'output extra debugging information')
    .version(getVersion(), '-v, --version', 'print SUSHI version')
    .arguments('<path-to-fsh-defs>')
    .action(function(pathToFshDefs) {
      input = pathToFshDefs;
    })
    .parse(process.argv);

  if (program.debug) logger.level = 'debug';

  // Check that input folder is specified
  if (!input) {
    logger.error('Missing path to FSH definition folder.');
    program.help();
  }

  let files: string[];
  try {
    files = fs.readdirSync(input, 'utf8');
  } catch {
    logger.error('Invalid path to FSH definition folder.');
    program.help();
  }

  // Check that package.json exists
  const packagePath = path.join(input, 'package.json');
  if (!fs.existsSync(packagePath)) {
    logger.error('No package.json in FSH definition folder.');
    return;
  }

  // Parse package.json
  let config: any;
  try {
    config = fs.readJSONSync(packagePath);
  } catch (e) {
    logger.error(`The package.json file is not valid JSON: ${packagePath}`);
    return;
  }

  // Load external dependencies
  const defs = new FHIRDefinitions();
  const dependencyDefs: Promise<FHIRDefinitions | void>[] = [];
  for (const dep of Object.keys(config?.dependencies ?? {})) {
    dependencyDefs.push(
      loadDependency(dep, config.dependencies[dep], defs)
        .then(def => {
          logger.info(`Loaded package ${dep}#${config.dependencies[dep]}`);
          return def;
        })
        .catch(e => {
          logger.error(`Failed to load ${dep}#${config.dependencies[dep]}`);
          logger.error(e.message);
        })
    );
  }

  const rawFSHes = files
    .filter(file => file.endsWith('.fsh'))
    .map(file => {
      const filePath = path.resolve(input, file);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      return new RawFSH(fileContent, filePath);
    });

  logger.info('Importing FSH text...');
  const docs = importText(rawFSHes);

  const tank = new FSHTank(docs, config);
  await Promise.all(dependencyDefs);
  logger.info('Converting FSH to FHIR resources...');
  const outPackage = exportFHIR(tank, defs);

  fs.ensureDirSync(program.out);

  fs.writeFileSync(
    path.join(program.out, 'package.json'),
    JSON.stringify(outPackage.config, null, 2),
    'utf8'
  );

  logger.info('Exporting FHIR resources as JSON...');
  let count = 0;
  const writeResources = (
    folder: string,
    resources: { getFileName: () => string; toJSON: () => any }[]
  ) => {
    const exportDir = path.join(program.out, 'input', folder);
    resources.forEach(resource => {
      fs.outputJSONSync(path.join(exportDir, resource.getFileName()), resource.toJSON(), {
        spaces: 2
      });
      count++;
    });
  };
  writeResources('profiles', outPackage.profiles);
  writeResources('extensions', outPackage.extensions);
  writeResources('vocabulary', [...outPackage.valueSets, ...outPackage.codeSystems]);
  writeResources('examples', outPackage.instances);
  logger.info(`Exported ${count} FHIR resources as JSON.`);

  // If ig-data exists, generate an IG, otherwise, generate resources only
  const igDataPath = path.resolve(input, 'ig-data');
  if (fs.existsSync(igDataPath)) {
    logger.info('Assembling Implementation Guide sources...');
    const igExporter = new IGExporter(outPackage, defs, igDataPath);
    igExporter.export(program.out);
    logger.info('Assembled Implementation Guide sources; ready for IG Publisher.');
  }

  logger.info(`
  Profiles:    ${outPackage.profiles.length}
  Extensions:  ${outPackage.extensions.length}
  Instances:   ${outPackage.instances.length}
  ValueSets:   ${outPackage.valueSets.length}
  CodeSystems: ${outPackage.codeSystems.length}
  Errors:      ${stats.numError}
  Warnings:    ${stats.numWarn}`);

  const exitCode = stats.numError > 0 ? 1 : 0;
  process.exit(exitCode);
}

function getVersion(): string {
  const packageJSONPath = path.join(__dirname, '..', 'package.json');
  if (fs.existsSync(packageJSONPath)) {
    const packageJSON = fs.readJSONSync(packageJSONPath);
    return `v${packageJSON.version}`;
  }
  return 'unknown';
}
