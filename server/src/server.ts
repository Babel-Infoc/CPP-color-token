/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	TextDocumentSyncKind,
	InitializeResult,
	ColorInformation,
	Color,
	DocumentColorParams,
	ColorPresentationParams,
	ColorPresentation,
	TextDocumentChangeEvent,
	DefinitionParams,
	Definition,
	Range
} from "vscode-languageserver";
import {
	TextDocument
} from "vscode-languageserver-textdocument";
import { IColors } from "./IColors";
import {
	JSONColorTokenSettings,
	defaultSettings,
	colorTokenPattern,
	rgbArrayPattern,
	cssVariablePattern,
	jsonKeyPattern,
	maxNumberOfColorTokensNotificationNamespace
} from "./constants";

// Create a connection for the server, using Node"s IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
let colorTokenCache: {
	[documentUri: string]: {
		[variable: string]: { color: string, range: Range }
	}
} = {};

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			colorProvider: true,
			definitionProvider: true
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log("Workspace folder change event received.");
		});
	}
});

let globalSettings: JSONColorTokenSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<JSONColorTokenSettings>> = new Map();
let cachedLanguages: string[] | undefined = undefined;
let cachedCSSLanguages: string[] | undefined = undefined;

async function isColorLanguage(languageId: string): Promise<boolean> {
	if (!cachedLanguages || !cachedCSSLanguages) {
		const settings = await getRemoteConfiguration() as JSONColorTokenSettings;
		cachedLanguages = settings.languages;
		cachedCSSLanguages = settings.cssLanguages;
	}

	// Although it is up to the user to separate css languages and languages that include color tokens.
	// We treat colliding languages as css languages to avoid chaos.
	return cachedCSSLanguages.indexOf(languageId) < 0 && cachedLanguages.indexOf(languageId) >= 0;
}

async function isCSSLanguage(languageId: string): Promise<boolean> {
	if (!cachedCSSLanguages) {
		const settings = await getRemoteConfiguration() as JSONColorTokenSettings;
		cachedCSSLanguages = settings.cssLanguages;
	}
	return cachedCSSLanguages.indexOf(languageId) >= 0;
}

function getGlobalSettings(): Thenable<JSONColorTokenSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = getRemoteConfiguration();
	return result;
}

function getRemoteConfiguration(): Promise<any> {
	return connection.workspace.getConfiguration({
		scopeUri: undefined,
		section: "jsonColorToken"
	});
}

// Only keep settings for open documents
documents.onDidClose(e => {
	if (!!colorTokenCache[e.document.uri]) {
		delete colorTokenCache[e.document.uri];
	}
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async (change: TextDocumentChangeEvent<TextDocument>) => {
	updateColorTokenCache(change.document);
});

function isColorToken(token: string | number | undefined): boolean {
	if (typeof token === "string") {
		let regex = new RegExp(colorTokenPattern);
		return regex.test(token);
	}
	return false;
}

async function updateColorTokenCache(textDocument: TextDocument): Promise<void> {
	if (await isColorLanguage(textDocument.languageId)) {
		let text = textDocument.getText();
		try {
			// Only try to parse JSON for JSON languages
			if (textDocument.languageId === "json" || textDocument.languageId === "jsonc") {
				let jsonObj = JSON.parse(text);
				let colorTokenObj: {
					[variable: string]: {
						color: string,
						range: Range
					}
				} = {};
				const regex = new RegExp(jsonKeyPattern);
				let m: RegExpExecArray | null;
				while ((m = regex.exec(text))) {
					const variableName = m.groups?.varDoulbeQuote ?? m.groups?.varSingleQuote;
					if (!!variableName && isColorToken(jsonObj[variableName])) {
						colorTokenObj[variableName] = {
							color: jsonObj[variableName],
							range: {
								start: textDocument.positionAt(m.index),
								end: textDocument.positionAt(m.index + variableName.length)
							}
						};
					}
				}

				colorTokenCache[textDocument.uri] = colorTokenObj;
			}
		} catch (error) {
			// Swallow the error
		}
	}
}

async function findColorTokens(textDocument: TextDocument): Promise<IColors[]> {
	const text = textDocument.getText();
	// Get the maxNumberOfColorTokens for every run.
	const settings = await getGlobalSettings();
	const { maxNumberOfColorTokens } = settings;

	let colors: IColors[] = [];
	if (await isColorLanguage(textDocument.languageId)) {
		// Process standard hex color tokens
		let regex = new RegExp(colorTokenPattern);
		let m: RegExpExecArray | null;
		let numTokens = 0;

		while ((m = regex.exec(text)) && numTokens < maxNumberOfColorTokens) {
			numTokens++;
			let color = m[0];

			colors.push({
				range: {
					start: textDocument.positionAt(m.index),
					end: textDocument.positionAt(m.index + color.length)
				},
				color: color
			});
			}

		// Process RGB arrays in CPP files
		if (textDocument.languageId === "cpp" || textDocument.languageId === "c++") {
			let rgbRegex = new RegExp(rgbArrayPattern);
			let rgbMatch: RegExpExecArray | null;

			while ((rgbMatch = rgbRegex.exec(text)) && numTokens < maxNumberOfColorTokens) {
				numTokens++;

				// Extract the RGB values from the match
				// The pattern captures r, g, b values in capture groups 2, 5, and 8
				const r = parseInt(rgbMatch[2], 10);
				const g = parseInt(rgbMatch[5], 10);
				const b = parseInt(rgbMatch[8], 10);

				// Convert to hex format for internal processing
				const hexColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

				colors.push({
					range: {
						start: textDocument.positionAt(rgbMatch.index),
						end: textDocument.positionAt(rgbMatch.index + rgbMatch[0].length)
					},
					color: hexColor
				});
			}
		}

		// If max number of color token is reached, show an info notification
		// and don't show this notification until a predefined amout of time has passed.
		if (numTokens === maxNumberOfColorTokens) {
			connection.sendNotification(maxNumberOfColorTokensNotificationNamespace, { count: maxNumberOfColorTokens });
		}
	} else if (await isCSSLanguage(textDocument.languageId)) {
		// Get reference to style variables
		const regex = new RegExp(cssVariablePattern);
		let m: RegExpExecArray | null;
		while ((m = regex.exec(text))) {
			let variableName = m.groups?.cssVar || "";
			// Show color preview of the first matching color token in color token cache
			const documentUri = Object.keys(colorTokenCache).find((uri) => !!colorTokenCache[uri][variableName]);
			if (!!documentUri) {
				colors.push({
					range: {
						start: textDocument.positionAt(m.index),
						end: textDocument.positionAt(m.index + m[0].length)
					},
					color: colorTokenCache[documentUri][variableName].color
				});
			}
		}
	}
	return colors;
}

/**
 * Convert a short hex code to its equivalent full hex code.
 *
 * @example
 * convertShortHexCodeToFullHexCode("#f00") // returns "#ff0000"
 * convertShortHexCodeToFullHexCode("#f00a") // returns "#ff0000aa"
 */
function convertShortHexCodeToFullHexCode(color: string): string {
	color = color.slice(1);
	return "#" + color.split("").map(hex => hex + hex).join("");
}

function parseColor(color: string): Color {
	if (color.length < 6) {
		color = convertShortHexCodeToFullHexCode(color);
	}

	const red = parseInt(color.slice(1, 3), 16) / 255;
	const green = parseInt(color.slice(3, 5), 16) / 255;
	const blue = parseInt(color.slice(5, 7), 16) / 255;

	let alpha = 1.0;

	if (color.length === 9) {
		alpha = parseInt(color.slice(7, 9), 16) / 255;
	}

	return { red, green, blue, alpha: alpha };
}

function stringifyColor(color: Color, casing: "Uppercase" | "Lowercase"): string {
	let result = "#";
	function valueToCode(val: number): string {
		let result = Math.floor(val * 255).toString(16);
		return result.length === 1 ? "0" + result : result;
	}

	result += valueToCode(color.red);
	result += valueToCode(color.green);
	result += valueToCode(color.blue);

	if (color.alpha < 1.0) {
		result += valueToCode(color.alpha);
	}

	if (casing === "Lowercase") {
		result = result.toLowerCase();
	} else {
		result = result.toUpperCase();
	}

	return result;
}

/**
 * Converts a color to RGB array format for CPP files: {r,g,b}
 */
function colorToRgbArray(color: Color): string {
	const r = Math.floor(color.red * 255);
	const g = Math.floor(color.green * 255);
	const b = Math.floor(color.blue * 255);
	return `{${r},${g},${b}}`;
}

// For color token variables referenced in css/less files,
// go to definition will bring to the json file where the token is defined.
connection.onDefinition(async (params: DefinitionParams): Promise<Definition | undefined> => {
	const { textDocument, position } = params;
	const textDocumentObj = documents.get(textDocument.uri);
	if (!textDocumentObj) {
		return;
	}
	const languageID = textDocumentObj.languageId;
	if (await isCSSLanguage(languageID)) {
		// Get the line of the text and try to parse out the first referenced css variable, if any
		const regex = new RegExp(cssVariablePattern);
		const lineText = textDocumentObj.getText({
			start: { line: position.line, character: 0 },
			end: { line: position.line + 1, character: 0 }
		});
		const m = regex.exec(lineText);
		if (!!m) {
			const variableName = m.groups?.cssVar || "";
			const documentUris = Object.keys(colorTokenCache).filter((uri) => !!colorTokenCache[uri][variableName]);
			return documentUris.map((uri) => {
				return {
					uri: uri,
					range: colorTokenCache[uri][variableName].range
				};
			});
		}
	}
});

connection.onDocumentColor(async (params: DocumentColorParams): Promise<ColorInformation[]> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}
	const colors = await findColorTokens(document);
	const colorInformationArray: ColorInformation[] = colors.map((colorObj) => {
		const color = parseColor(colorObj.color);
		return {
			range: colorObj.range,
			color: color
		};
	});
	return colorInformationArray;
});

connection.onColorPresentation(async (params: ColorPresentationParams): Promise<ColorPresentation[]> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}

	if (await isColorLanguage(document.languageId)) {
		let settings = await getGlobalSettings();

		// For CPP files, return the RGB array format
		if (document.languageId === "cpp" || document.languageId === "c++") {
			return [{ label: colorToRgbArray(params.color) }];
		}

		// For other supported formats, use hex format
		return [{ label: stringifyColor(params.color, settings.colorTokenCasing) }];
	}
	return [];
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
