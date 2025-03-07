/**
 * @fileoverview Helper functions for ESLint class
 * @author Nicholas C. Zakas
 */

"use strict";

//-----------------------------------------------------------------------------
// Requirements
//-----------------------------------------------------------------------------

const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const isGlob = require("is-glob");
const hash = require("../cli-engine/hash");
const minimatch = require("minimatch");
const util = require("util");
const fswalk = require("@nodelib/fs.walk");

//-----------------------------------------------------------------------------
// Fixup references
//-----------------------------------------------------------------------------

const doFsWalk = util.promisify(fswalk.walk);
const Minimatch = minimatch.Minimatch;

//-----------------------------------------------------------------------------
// Errors
//-----------------------------------------------------------------------------

/**
 * The error type when no files match a glob.
 */
class NoFilesFoundError extends Error {

    /**
     * @param {string} pattern The glob pattern which was not found.
     * @param {boolean} globEnabled If `false` then the pattern was a glob pattern, but glob was disabled.
     */
    constructor(pattern, globEnabled) {
        super(`No files matching '${pattern}' were found${!globEnabled ? " (glob was disabled)" : ""}.`);
        this.messageTemplate = "file-not-found";
        this.messageData = { pattern, globDisabled: !globEnabled };
    }
}

/**
 * The error type when there are files matched by a glob, but all of them have been ignored.
 */
class AllFilesIgnoredError extends Error {

    /**
     * @param {string} pattern The glob pattern which was not found.
     */
    constructor(pattern) {
        super(`All files matched by '${pattern}' are ignored.`);
        this.messageTemplate = "all-files-ignored";
        this.messageData = { pattern };
    }
}


//-----------------------------------------------------------------------------
// General Helpers
//-----------------------------------------------------------------------------

/**
 * Check if a given value is a non-empty string or not.
 * @param {any} x The value to check.
 * @returns {boolean} `true` if `x` is a non-empty string.
 */
function isNonEmptyString(x) {
    return typeof x === "string" && x.trim() !== "";
}

/**
 * Check if a given value is an array of non-empty strings or not.
 * @param {any} x The value to check.
 * @returns {boolean} `true` if `x` is an array of non-empty strings.
 */
function isArrayOfNonEmptyString(x) {
    return Array.isArray(x) && x.every(isNonEmptyString);
}

//-----------------------------------------------------------------------------
// File-related Helpers
//-----------------------------------------------------------------------------

/**
 * Normalizes slashes in a file pattern to posix-style.
 * @param {string} pattern The pattern to replace slashes in.
 * @returns {string} The pattern with slashes normalized.
 */
function normalizeToPosix(pattern) {
    return pattern.replace(/\\/gu, "/");
}

/**
 * Check if a string is a glob pattern or not.
 * @param {string} pattern A glob pattern.
 * @returns {boolean} `true` if the string is a glob pattern.
 */
function isGlobPattern(pattern) {
    return isGlob(path.sep === "\\" ? normalizeToPosix(pattern) : pattern);
}

/**
 * Searches a directory looking for matching glob patterns. This uses
 * the config array's logic to determine if a directory or file should
 * be ignored, so it is consistent with how ignoring works throughout
 * ESLint.
 * @param {Object} options The options for this function.
 * @param {string} options.cwd The directory to search.
 * @param {Array<string>} options.patterns An array of glob patterns
 *      to match.
 * @param {FlatConfigArray} options.configs The config array to use for
 *      determining what to ignore.
 * @returns {Promise<Array<string>>} An array of matching file paths
 *      or an empty array if there are no matches.
 */
async function globSearch({ cwd, patterns, configs }) {

    if (patterns.length === 0) {
        return [];
    }

    const matchers = patterns.map(pattern => {
        const patternToUse = path.isAbsolute(pattern)
            ? normalizeToPosix(path.relative(cwd, pattern))
            : pattern;

        return new minimatch.Minimatch(patternToUse);
    });

    return (await doFsWalk(cwd, {

        deepFilter(entry) {
            const relativePath = normalizeToPosix(path.relative(cwd, entry.path));
            const matchesPattern = matchers.some(matcher => matcher.match(relativePath, true));

            return matchesPattern && !configs.isDirectoryIgnored(entry.path);
        },
        entryFilter(entry) {
            const relativePath = normalizeToPosix(path.relative(cwd, entry.path));

            // entries may be directories or files so filter out directories
            if (entry.dirent.isDirectory()) {
                return false;
            }

            const matchesPattern = matchers.some(matcher => matcher.match(relativePath));

            return matchesPattern && !configs.isFileIgnored(entry.path);
        }
    })).map(entry => entry.path);

}

/**
 * Determines if a given glob pattern will return any results.
 * Used primarily to help with useful error messages.
 * @param {Object} options The options for the function.
 * @param {string} options.cwd The directory to search.
 * @param {string} options.pattern A glob pattern to match.
 * @returns {Promise<boolean>} True if there is a glob match, false if not.
 */
function globMatch({ cwd, pattern }) {

    let found = false;
    const patternToUse = path.isAbsolute(pattern)
        ? normalizeToPosix(path.relative(cwd, pattern))
        : pattern;

    const matcher = new Minimatch(patternToUse);

    const fsWalkSettings = {

        deepFilter(entry) {
            const relativePath = normalizeToPosix(path.relative(cwd, entry.path));

            return !found && matcher.match(relativePath, true);
        },

        entryFilter(entry) {
            if (found || entry.dirent.isDirectory()) {
                return false;
            }

            const relativePath = normalizeToPosix(path.relative(cwd, entry.path));

            if (matcher.match(relativePath)) {
                found = true;
                return true;
            }

            return false;
        }
    };

    return new Promise(resolve => {

        // using a stream so we can exit early because we just need one match
        const globStream = fswalk.walkStream(cwd, fsWalkSettings);

        globStream.on("data", () => {
            globStream.destroy();
            resolve(true);
        });

        // swallow errors as they're not important here
        globStream.on("error", () => {});

        globStream.on("end", () => {
            resolve(false);
        });
        globStream.read();
    });

}

/**
 * Finds all files matching the options specified.
 * @param {Object} args The arguments objects.
 * @param {Array<string>} args.patterns An array of glob patterns.
 * @param {boolean} args.globInputPaths true to interpret glob patterns,
 *      false to not interpret glob patterns.
 * @param {string} args.cwd The current working directory to find from.
 * @param {FlatConfigArray} args.configs The configs for the current run.
 * @param {boolean} args.errorOnUnmatchedPattern Determines if an unmatched pattern
 *      should throw an error.
 * @returns {Promise<Array<string>>} The fully resolved file paths.
 * @throws {AllFilesIgnoredError} If there are no results due to an ignore pattern.
 * @throws {NoFilesFoundError} If no files matched the given patterns.
 */
async function findFiles({
    patterns,
    globInputPaths,
    cwd,
    configs,
    errorOnUnmatchedPattern
}) {

    const results = [];
    const globbyPatterns = [];
    const missingPatterns = [];

    // check to see if we have explicit files and directories
    const filePaths = patterns.map(filePath => path.resolve(cwd, filePath));
    const stats = await Promise.all(
        filePaths.map(
            filePath => fsp.stat(filePath).catch(() => { })
        )
    );

    stats.forEach((stat, index) => {

        const filePath = filePaths[index];
        const pattern = normalizeToPosix(patterns[index]);

        if (stat) {

            // files are added directly to the list
            if (stat.isFile()) {
                results.push({
                    filePath,
                    ignored: configs.isFileIgnored(filePath)
                });
            }

            // directories need extensions attached
            if (stat.isDirectory()) {

                // filePatterns are all relative to cwd
                const filePatterns = configs.files
                    .filter(filePattern => {

                        // can only do this for strings, not functions
                        if (typeof filePattern !== "string") {
                            return false;
                        }

                        // patterns starting with ** always apply
                        if (filePattern.startsWith("**")) {
                            return true;
                        }

                        // patterns ending with * are not used for file search
                        if (filePattern.endsWith("*")) {
                            return false;
                        }

                        // not sure how to handle negated patterns yet
                        if (filePattern.startsWith("!")) {
                            return false;
                        }

                        // check if the pattern would be inside the config base path or not
                        const fullFilePattern = path.join(cwd, filePattern);
                        const patternRelativeToConfigBasePath = path.relative(configs.basePath, fullFilePattern);

                        if (patternRelativeToConfigBasePath.startsWith("..")) {
                            return false;
                        }

                        // check if the pattern matches
                        if (minimatch(filePath, path.dirname(fullFilePattern), { partial: true })) {
                            return true;
                        }

                        // check if the pattern is inside the directory or not
                        const patternRelativeToFilePath = path.relative(filePath, fullFilePattern);

                        if (patternRelativeToFilePath.startsWith("..")) {
                            return false;
                        }

                        return true;
                    })
                    .map(filePattern => {
                        if (filePattern.startsWith("**")) {
                            return path.join(pattern, filePattern);
                        }

                        // adjust the path to be relative to the cwd
                        return path.relative(
                            cwd,
                            path.join(configs.basePath, filePattern)
                        );
                    })
                    .map(normalizeToPosix);

                if (filePatterns.length) {
                    globbyPatterns.push(...filePatterns);
                }

            }

            return;
        }

        // save patterns for later use based on whether globs are enabled
        if (globInputPaths && isGlobPattern(filePath)) {
            globbyPatterns.push(pattern);
        } else {
            missingPatterns.push(pattern);
        }
    });

    // note: globbyPatterns can be an empty array
    const globbyResults = await globSearch({
        cwd,
        patterns: globbyPatterns,
        configs,
        shouldIgnore: true
    });

    // if there are no results, tell the user why
    if (!results.length && !globbyResults.length) {

        // try globby without ignoring anything
        for (const globbyPattern of globbyPatterns) {

            // check if there are any matches at all
            const patternHasMatch = await globMatch({
                cwd,
                pattern: globbyPattern
            });

            if (patternHasMatch) {
                throw new AllFilesIgnoredError(globbyPattern);
            }

            // otherwise no files were found
            if (errorOnUnmatchedPattern) {
                throw new NoFilesFoundError(globbyPattern, globInputPaths);
            }
        }

    }

    // there were patterns that didn't match anything, tell the user
    if (errorOnUnmatchedPattern && missingPatterns.length) {
        throw new NoFilesFoundError(missingPatterns[0], globInputPaths);
    }


    return [
        ...results,
        ...globbyResults.map(filePath => ({
            filePath: path.resolve(filePath),
            ignored: false
        }))
    ];
}


/**
 * Checks whether a file exists at the given location
 * @param {string} resolvedPath A path from the CWD
 * @throws {Error} As thrown by `fs.statSync` or `fs.isFile`.
 * @returns {boolean} `true` if a file exists
 */
function fileExists(resolvedPath) {
    try {
        return fs.statSync(resolvedPath).isFile();
    } catch (error) {
        if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            return false;
        }
        throw error;
    }
}

/**
 * Checks whether a directory exists at the given location
 * @param {string} resolvedPath A path from the CWD
 * @throws {Error} As thrown by `fs.statSync` or `fs.isDirectory`.
 * @returns {boolean} `true` if a directory exists
 */
function directoryExists(resolvedPath) {
    try {
        return fs.statSync(resolvedPath).isDirectory();
    } catch (error) {
        if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            return false;
        }
        throw error;
    }
}

//-----------------------------------------------------------------------------
// Results-related Helpers
//-----------------------------------------------------------------------------

/**
 * Checks if the given message is an error message.
 * @param {LintMessage} message The message to check.
 * @returns {boolean} Whether or not the message is an error message.
 * @private
 */
function isErrorMessage(message) {
    return message.severity === 2;
}

/**
 * Returns result with warning by ignore settings
 * @param {string} filePath File path of checked code
 * @param {string} baseDir Absolute path of base directory
 * @returns {LintResult} Result with single warning
 * @private
 */
function createIgnoreResult(filePath, baseDir) {
    let message;
    const isHidden = filePath.split(path.sep)
        .find(segment => /^\./u.test(segment));
    const isInNodeModules = baseDir && path.relative(baseDir, filePath).startsWith("node_modules");

    if (isHidden) {
        message = "File ignored by default.  Use a negated ignore pattern (like \"--ignore-pattern '!<relative/path/to/filename>'\") to override.";
    } else if (isInNodeModules) {
        message = "File ignored by default. Use \"--ignore-pattern '!node_modules/*'\" to override.";
    } else {
        message = "File ignored because of a matching ignore pattern. Use \"--no-ignore\" to override.";
    }

    return {
        filePath: path.resolve(filePath),
        messages: [
            {
                fatal: false,
                severity: 1,
                message
            }
        ],
        suppressedMessages: [],
        errorCount: 0,
        warningCount: 1,
        fatalErrorCount: 0,
        fixableErrorCount: 0,
        fixableWarningCount: 0
    };
}

//-----------------------------------------------------------------------------
// Options-related Helpers
//-----------------------------------------------------------------------------


/**
 * Check if a given value is a valid fix type or not.
 * @param {any} x The value to check.
 * @returns {boolean} `true` if `x` is valid fix type.
 */
function isFixType(x) {
    return x === "directive" || x === "problem" || x === "suggestion" || x === "layout";
}

/**
 * Check if a given value is an array of fix types or not.
 * @param {any} x The value to check.
 * @returns {boolean} `true` if `x` is an array of fix types.
 */
function isFixTypeArray(x) {
    return Array.isArray(x) && x.every(isFixType);
}

/**
 * The error for invalid options.
 */
class ESLintInvalidOptionsError extends Error {
    constructor(messages) {
        super(`Invalid Options:\n- ${messages.join("\n- ")}`);
        this.code = "ESLINT_INVALID_OPTIONS";
        Error.captureStackTrace(this, ESLintInvalidOptionsError);
    }
}

/**
 * Validates and normalizes options for the wrapped CLIEngine instance.
 * @param {FlatESLintOptions} options The options to process.
 * @throws {ESLintInvalidOptionsError} If of any of a variety of type errors.
 * @returns {FlatESLintOptions} The normalized options.
 */
function processOptions({
    allowInlineConfig = true, // ← we cannot use `overrideConfig.noInlineConfig` instead because `allowInlineConfig` has side-effect that suppress warnings that show inline configs are ignored.
    baseConfig = null,
    cache = false,
    cacheLocation = ".eslintcache",
    cacheStrategy = "metadata",
    cwd = process.cwd(),
    errorOnUnmatchedPattern = true,
    fix = false,
    fixTypes = null, // ← should be null by default because if it's an array then it suppresses rules that don't have the `meta.type` property.
    globInputPaths = true,
    ignore = true,
    ignorePatterns = null,
    overrideConfig = null,
    overrideConfigFile = null,
    plugins = {},
    reportUnusedDisableDirectives = null, // ← should be null by default because if it's a string then it overrides the 'reportUnusedDisableDirectives' setting in config files. And we cannot use `overrideConfig.reportUnusedDisableDirectives` instead because we cannot configure the `error` severity with that.
    ...unknownOptions
}) {
    const errors = [];
    const unknownOptionKeys = Object.keys(unknownOptions);

    if (unknownOptionKeys.length >= 1) {
        errors.push(`Unknown options: ${unknownOptionKeys.join(", ")}`);
        if (unknownOptionKeys.includes("cacheFile")) {
            errors.push("'cacheFile' has been removed. Please use the 'cacheLocation' option instead.");
        }
        if (unknownOptionKeys.includes("configFile")) {
            errors.push("'configFile' has been removed. Please use the 'overrideConfigFile' option instead.");
        }
        if (unknownOptionKeys.includes("envs")) {
            errors.push("'envs' has been removed.");
        }
        if (unknownOptionKeys.includes("extensions")) {
            errors.push("'extensions' has been removed.");
        }
        if (unknownOptionKeys.includes("resolvePluginsRelativeTo")) {
            errors.push("'resolvePluginsRelativeTo' has been removed.");
        }
        if (unknownOptionKeys.includes("globals")) {
            errors.push("'globals' has been removed. Please use the 'overrideConfig.languageOptions.globals' option instead.");
        }
        if (unknownOptionKeys.includes("ignorePath")) {
            errors.push("'ignorePath' has been removed.");
        }
        if (unknownOptionKeys.includes("ignorePattern")) {
            errors.push("'ignorePattern' has been removed. Please use the 'overrideConfig.ignorePatterns' option instead.");
        }
        if (unknownOptionKeys.includes("parser")) {
            errors.push("'parser' has been removed. Please use the 'overrideConfig.languageOptions.parser' option instead.");
        }
        if (unknownOptionKeys.includes("parserOptions")) {
            errors.push("'parserOptions' has been removed. Please use the 'overrideConfig.languageOptions.parserOptions' option instead.");
        }
        if (unknownOptionKeys.includes("rules")) {
            errors.push("'rules' has been removed. Please use the 'overrideConfig.rules' option instead.");
        }
        if (unknownOptionKeys.includes("rulePaths")) {
            errors.push("'rulePaths' has been removed. Please define your rules using plugins.");
        }
    }
    if (typeof allowInlineConfig !== "boolean") {
        errors.push("'allowInlineConfig' must be a boolean.");
    }
    if (typeof baseConfig !== "object") {
        errors.push("'baseConfig' must be an object or null.");
    }
    if (typeof cache !== "boolean") {
        errors.push("'cache' must be a boolean.");
    }
    if (!isNonEmptyString(cacheLocation)) {
        errors.push("'cacheLocation' must be a non-empty string.");
    }
    if (
        cacheStrategy !== "metadata" &&
        cacheStrategy !== "content"
    ) {
        errors.push("'cacheStrategy' must be any of \"metadata\", \"content\".");
    }
    if (!isNonEmptyString(cwd) || !path.isAbsolute(cwd)) {
        errors.push("'cwd' must be an absolute path.");
    }
    if (typeof errorOnUnmatchedPattern !== "boolean") {
        errors.push("'errorOnUnmatchedPattern' must be a boolean.");
    }
    if (typeof fix !== "boolean" && typeof fix !== "function") {
        errors.push("'fix' must be a boolean or a function.");
    }
    if (fixTypes !== null && !isFixTypeArray(fixTypes)) {
        errors.push("'fixTypes' must be an array of any of \"directive\", \"problem\", \"suggestion\", and \"layout\".");
    }
    if (typeof globInputPaths !== "boolean") {
        errors.push("'globInputPaths' must be a boolean.");
    }
    if (typeof ignore !== "boolean") {
        errors.push("'ignore' must be a boolean.");
    }
    if (typeof overrideConfig !== "object") {
        errors.push("'overrideConfig' must be an object or null.");
    }
    if (!isNonEmptyString(overrideConfigFile) && overrideConfigFile !== null && overrideConfigFile !== true) {
        errors.push("'overrideConfigFile' must be a non-empty string, null, or true.");
    }
    if (typeof plugins !== "object") {
        errors.push("'plugins' must be an object or null.");
    } else if (plugins !== null && Object.keys(plugins).includes("")) {
        errors.push("'plugins' must not include an empty string.");
    }
    if (Array.isArray(plugins)) {
        errors.push("'plugins' doesn't add plugins to configuration to load. Please use the 'overrideConfig.plugins' option instead.");
    }
    if (
        reportUnusedDisableDirectives !== "error" &&
        reportUnusedDisableDirectives !== "warn" &&
        reportUnusedDisableDirectives !== "off" &&
        reportUnusedDisableDirectives !== null
    ) {
        errors.push("'reportUnusedDisableDirectives' must be any of \"error\", \"warn\", \"off\", and null.");
    }
    if (errors.length > 0) {
        throw new ESLintInvalidOptionsError(errors);
    }

    return {
        allowInlineConfig,
        baseConfig,
        cache,
        cacheLocation,
        cacheStrategy,

        // when overrideConfigFile is true that means don't do config file lookup
        configFile: overrideConfigFile === true ? false : overrideConfigFile,
        overrideConfig,
        cwd,
        errorOnUnmatchedPattern,
        fix,
        fixTypes,
        globInputPaths,
        ignore,
        ignorePatterns,
        reportUnusedDisableDirectives
    };
}


//-----------------------------------------------------------------------------
// Cache-related helpers
//-----------------------------------------------------------------------------

/**
 * return the cacheFile to be used by eslint, based on whether the provided parameter is
 * a directory or looks like a directory (ends in `path.sep`), in which case the file
 * name will be the `cacheFile/.cache_hashOfCWD`
 *
 * if cacheFile points to a file or looks like a file then in will just use that file
 * @param {string} cacheFile The name of file to be used to store the cache
 * @param {string} cwd Current working directory
 * @returns {string} the resolved path to the cache file
 */
function getCacheFile(cacheFile, cwd) {

    /*
     * make sure the path separators are normalized for the environment/os
     * keeping the trailing path separator if present
     */
    const normalizedCacheFile = path.normalize(cacheFile);

    const resolvedCacheFile = path.resolve(cwd, normalizedCacheFile);
    const looksLikeADirectory = normalizedCacheFile.slice(-1) === path.sep;

    /**
     * return the name for the cache file in case the provided parameter is a directory
     * @returns {string} the resolved path to the cacheFile
     */
    function getCacheFileForDirectory() {
        return path.join(resolvedCacheFile, `.cache_${hash(cwd)}`);
    }

    let fileStats;

    try {
        fileStats = fs.lstatSync(resolvedCacheFile);
    } catch {
        fileStats = null;
    }


    /*
     * in case the file exists we need to verify if the provided path
     * is a directory or a file. If it is a directory we want to create a file
     * inside that directory
     */
    if (fileStats) {

        /*
         * is a directory or is a file, but the original file the user provided
         * looks like a directory but `path.resolve` removed the `last path.sep`
         * so we need to still treat this like a directory
         */
        if (fileStats.isDirectory() || looksLikeADirectory) {
            return getCacheFileForDirectory();
        }

        // is file so just use that file
        return resolvedCacheFile;
    }

    /*
     * here we known the file or directory doesn't exist,
     * so we will try to infer if its a directory if it looks like a directory
     * for the current operating system.
     */

    // if the last character passed is a path separator we assume is a directory
    if (looksLikeADirectory) {
        return getCacheFileForDirectory();
    }

    return resolvedCacheFile;
}


//-----------------------------------------------------------------------------
// Exports
//-----------------------------------------------------------------------------

module.exports = {
    isGlobPattern,
    directoryExists,
    fileExists,
    findFiles,

    isNonEmptyString,
    isArrayOfNonEmptyString,

    createIgnoreResult,
    isErrorMessage,

    processOptions,

    getCacheFile
};
