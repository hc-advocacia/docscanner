import { DocumentScanner } from '@devantage/docscanify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { TransportName } from '../cli/cli-options.class';
import {
  ImageSourceResolver,
  type ImageSourceResolverOptions,
} from '../tools/scan-document/image-source-resolver.class';
import { ScanDocumentTool } from '../tools/scan-document/scan-document.tool';
import { ScanOutputWriter } from '../tools/scan-document/scan-output-writer.class';

/** What the servers are created with. */
export interface DocScanifyMcpServerOptions {
  /** Version the server reports to its clients */
  version: string;

  /** The transport the servers are connected to, which decides what touches the disk */
  transport: TransportName;

  /** Default: a scanner with the adapters of docscanify */
  scanner?: DocumentScanner;

  /** Replaces the global fetch of the image downloads, for tests */
  fetch?: ImageSourceResolverOptions['fetch'];
}

/** Creates the MCP servers of DocScanify, with their tools registered. */
export class DocScanifyMcpServer {
  public static readonly NAME: string = 'docscanner';

  private readonly scanDocumentTool: ScanDocumentTool;

  public constructor(private readonly options: DocScanifyMcpServerOptions) {
    this.scanDocumentTool = new ScanDocumentTool({
      scanner: options.scanner ?? new DocumentScanner(),
      imageSourceResolver: new ImageSourceResolver({
        transport: options.transport,
        fetch: options.fetch,
      }),
      scanOutputWriter: new ScanOutputWriter(),
      transport: options.transport,
    });
  }

  /** A new server, since each one connects to a single transport. */
  public create(): McpServer {
    const server: McpServer = new McpServer({
      name: DocScanifyMcpServer.NAME,
      version: this.options.version,
    });

    this.scanDocumentTool.register(server);

    return server;
  }
}
