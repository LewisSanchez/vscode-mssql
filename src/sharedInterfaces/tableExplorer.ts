/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConnectionProfile } from "../models/interfaces";

export interface TableExplorerWebViewState {
    tableName: string;
    databaseName: string;
    serverName: string;
    schemaName?: string;
    connectionProfile?: IConnectionProfile;
    isLoading: boolean;
    tableMetadata?: any; // This would be more specific based on actual metadata structure
}

export type TableExplorerReducers =
    | {
          type: "getTableInfo";
      }
    | {
          type: "refreshTableInfo";
      };
