#!/usr/bin/env node

/**
 * Bumps all package versions to today's date (YYYY.M.D format).
 * Used for lockstep daily versioning before publish.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const today = new Date();
const newVersion = `${today.getFullYear()}.${today.getMonth() + 1}.${today.getDate()}`;

console.log(`Bumping all packages to version ${newVersion}...\n`);

const packagesDir = join(process.cwd(), 'packages');
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

// Update root package.json
const rootPkgPath = join(process.cwd(), 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const oldVersion = rootPkg.version;
rootPkg.version = newVersion;
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
console.log(`Root: ${oldVersion} → ${newVersion}`);

// Update all package package.json files
let updated = 0;
for (const dir of packageDirs) {
	const pkgPath = join(packagesDir, dir, 'package.json');
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		const oldPkgVersion = pkg.version;
		pkg.version = newVersion;
		
		// Also update inter-package dependencies
		if (pkg.dependencies) {
			for (const [depName, depVersion] of Object.entries(pkg.dependencies)) {
				if (depVersion.startsWith('@mariozechner/') || depVersion.startsWith('@draht/')) {
					pkg.dependencies[depName] = `^${newVersion}`;
				}
			}
		}
		
		writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
		console.log(`${pkg.name}: ${oldPkgVersion} → ${newVersion}`);
		updated++;
	} catch (e) {
		console.error(`Failed to update ${pkgPath}:`, e.message);
	}
}

console.log(`\n✅ Updated ${updated + 1} package(s) to ${newVersion}`);
