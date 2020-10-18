/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionItemProvider, TextDocument, Position, CompletionContext, CompletionList, CompletionItem, MarkdownString, TextEdit, Range, SnippetString, window, Selection, WorkspaceEdit, workspace } from "vscode";
import AbstractProvider from "./abstractProvider";
import * as protocol from "../omnisharp/protocol";
import * as serverUtils from '../omnisharp/utils';
import { CancellationToken, CompletionTriggerKind as LspCompletionTriggerKind, InsertTextFormat } from "vscode-languageserver-protocol";
import { createRequest } from "../omnisharp/typeConversion";
import OptionProvider from "../observers/OptionProvider";
import { LanguageMiddlewareFeature } from "../omnisharp/LanguageMiddlewareFeature";
import { OmniSharpServer } from "../omnisharp/server";

export const CompletionAfterInsertCommand = "csharp.completion.afterInsert";

export default class OmnisharpCompletionProvider extends AbstractProvider implements CompletionItemProvider {

    #lastCompletions?: Map<CompletionItem, protocol.OmnisharpCompletionItem>;

    constructor(server: OmniSharpServer, private optionProvider: OptionProvider, languageMiddlewareFeature: LanguageMiddlewareFeature) {
        super(server, languageMiddlewareFeature);
    }

    public async provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext): Promise<CompletionList> {
        let request = createRequest<protocol.CompletionRequest>(document, position);
        request.CompletionTrigger = (context.triggerKind + 1) as LspCompletionTriggerKind;
        request.TriggerCharacter = context.triggerCharacter;
        const options = this.optionProvider.GetLatestOptions();
        request.UseAsyncCompletion = options.enableAsyncCompletion;

        try {
            const response = await serverUtils.getCompletion(this._server, request, token);
            const mappedItems = response.Items.map(arg => this._convertToVscodeCompletionItem(arg, options.enableAsyncCompletion));

            let lastCompletions = new Map();

            for (let i = 0; i < mappedItems.length; i++) {
                lastCompletions.set(mappedItems[i], response.Items[i]);
            }

            this.#lastCompletions = lastCompletions;

            return { items: mappedItems };
        }
        catch (error) {
            return;
        }
    }

    public async resolveCompletionItem(item: CompletionItem, token: CancellationToken): Promise<CompletionItem> {
        const lastCompletions = this.#lastCompletions;
        if (!lastCompletions) {
            return item;
        }

        const lspItem = lastCompletions.get(item);
        if (!lspItem) {
            return item;
        }

        const request: protocol.CompletionResolveRequest = { Item: lspItem };
        try {
            const response = await serverUtils.getCompletionResolve(this._server, request, token);
            const wasCreatedWithAsyncCompletion: boolean = !!item.command;
            return this._convertToVscodeCompletionItem(response.Item, wasCreatedWithAsyncCompletion);
        }
        catch (error) {
            return;
        }
    }

    public async afterInsert(item: protocol.OmnisharpCompletionItem) {
        try {
            const { document: { fileName, uri }, selection: { active: { line, character } } } = window.activeTextEditor;
            const response = await serverUtils.getCompletionAfterInsert(this._server, { Item: item, FileName: fileName, Line: line + 1, Column: character + 1 });

            if (!response.Change || !response.Column || !response.Line) {
                return;
            }

            let edit = new WorkspaceEdit();
            edit.set(uri, [{
                newText: response.Change.NewText,
                range: new Range(new Position(response.Change.StartLine, response.Change.StartColumn),
                                 new Position(response.Change.EndLine, response.Change.EndColumn))
            }]);

            edit = await this._languageMiddlewareFeature.remap("remapWorkspaceEdit", edit, CancellationToken.None);

            const applied = await workspace.applyEdit(edit);
            if (!applied) {
                return;
            }

            const responseLine = response.Line - 1;
            const responseColumn = response.Column - 1;

            const finalPosition = new Position(responseLine, responseColumn);
            window.activeTextEditor.selections = [new Selection(finalPosition, finalPosition)];
        }
        catch (error) {
            return;
        }
    }

    private _convertToVscodeCompletionItem(omnisharpCompletion: protocol.OmnisharpCompletionItem, enableAsyncCompletion: boolean): CompletionItem {
        const docs: MarkdownString | undefined = omnisharpCompletion.Documentation ? new MarkdownString(omnisharpCompletion.Documentation, false) : undefined;

        const mapRange = function (edit: protocol.LinePositionSpanTextChange): Range {
            const newStart = new Position(edit.StartLine - 1, edit.StartColumn - 1);
            const newEnd = new Position(edit.EndLine - 1, edit.EndColumn - 1);
            return new Range(newStart, newEnd);
        };

        const mapTextEdit = function (edit: protocol.LinePositionSpanTextChange): TextEdit {
            return new TextEdit(mapRange(edit), edit.NewText);
        };

        const additionalTextEdits = omnisharpCompletion.AdditionalTextEdits?.map(mapTextEdit);

        const newText = omnisharpCompletion.TextEdit?.NewText ?? omnisharpCompletion.InsertText;
        const insertText = omnisharpCompletion.InsertTextFormat === InsertTextFormat.Snippet
            ? new SnippetString(newText)
            : newText;

        const insertRange = omnisharpCompletion.TextEdit ? mapRange(omnisharpCompletion.TextEdit) : undefined;

        return {
            label: omnisharpCompletion.Label,
            kind: omnisharpCompletion.Kind - 1,
            detail: omnisharpCompletion.Detail,
            documentation: docs,
            commitCharacters: omnisharpCompletion.CommitCharacters,
            preselect: omnisharpCompletion.Preselect,
            filterText: omnisharpCompletion.FilterText,
            insertText: insertText,
            range: insertRange,
            tags: omnisharpCompletion.Tags,
            sortText: omnisharpCompletion.SortText,
            additionalTextEdits: additionalTextEdits,
            keepWhitespace: true,
            command: enableAsyncCompletion ? { command: CompletionAfterInsertCommand, title: "", arguments: [omnisharpCompletion] } : undefined
        };
    }
}
