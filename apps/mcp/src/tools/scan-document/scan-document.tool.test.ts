import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  CallToolResult,
  ImageContent,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { PDFDocument } from 'pdf-lib';

import type { TransportName } from '../../cli/cli-options.class';
import { DocScanifyMcpServer } from '../../server/docscanify-mcp-server.class';
import { createBlankPhoto, createDocumentPhoto } from '../../test-helpers';
import type { ScanDocumentOutput, ScanPdfArea } from './scan-document.schema';

const PHOTO: Buffer = createDocumentPhoto();

/**
 * Connects a client to a new server of the given transport.
 *
 * @returns the client, to close after the test
 */
async function connect(transport: TransportName): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client: Client = new Client({ name: 'test', version: '1.0.0' });

  await new DocScanifyMcpServer({ version: '1.0.0', transport })
    .create()
    .connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

/**
 * Calls scan_document.
 *
 * @param client a connected client
 * @param args the arguments of the tool
 */
async function scan(
  client: Client,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({
    name: 'scan_document',
    arguments: args,
  })) as CallToolResult;
}

/**
 * The text of the first content of a result.
 *
 * @param result a tool result
 */
function getText(result: CallToolResult): string {
  const text: CallToolResult['content'][number] | undefined =
    result.content.find(
      (content: CallToolResult['content'][number]): boolean =>
        content.type === 'text',
    );

  return text?.type === 'text' ? text.text : '';
}

describe('ScanDocumentTool', (): void => {
  let client: Client;
  let directory: string;

  beforeAll(async (): Promise<void> => {
    client = await connect('stdio');
    directory = await mkdtemp(join(tmpdir(), 'docscanify-mcp-'));
    await writeFile(join(directory, 'photo.png'), PHOTO);
  });

  afterAll(async (): Promise<void> => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('is served by the docscanner server', (): void => {
    expect(client.getServerVersion()?.name).toBe('docscanner');
  });

  it('is listed with its input and output schemas', async (): Promise<void> => {
    const { tools }: ListToolsResult = await client.listTools();

    expect(
      tools.map(({ name }: ListToolsResult['tools'][number]): string => name),
    ).toEqual(['scan_document']);
    expect(Object.keys(tools[0].inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        'imageBase64',
        'imageUrl',
        'imagePath',
        'outputPath',
      ]),
    );
    expect(tools[0].outputSchema?.required).toEqual(
      expect.arrayContaining(['detected', 'corners', 'width', 'height']),
    );
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: false });
  });

  it('returns a PDF as an embedded resource by default', async (): Promise<void> => {
    const result: CallToolResult = await scan(client, {
      imageBase64: PHOTO.toString('base64'),
    });
    const output: ScanDocumentOutput =
      result.structuredContent as unknown as ScanDocumentOutput;

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: 'resource',
      resource: {
        uri: 'docscanify://scans/scan.pdf',
        mimeType: 'application/pdf',
        blob: expect.any(String) as unknown,
      },
    });
    expect(
      Buffer.from(
        (result.content[0] as { resource: { blob: string } }).resource.blob,
        'base64',
      )
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    expect(output).toMatchObject({
      detected: true,
      mimeType: 'application/pdf',
      fileName: 'scan.pdf',
    });
    expect(output.corners?.topLeft.x).toBeCloseTo(140, -1);
    expect(JSON.parse(getText(result))).toEqual(output);
  });

  it('returns how the document was laid out on the PDF page', async (): Promise<void> => {
    const result: CallToolResult = await scan(client, {
      imageBase64: PHOTO.toString('base64'),
      pageSize: 'letter',
      margin: 36,
    });
    const output: ScanDocumentOutput =
      result.structuredContent as unknown as ScanDocumentOutput;
    const pdf: PDFDocument = await PDFDocument.load(
      Buffer.from(
        (result.content[0] as { resource: { blob: string } }).resource.blob,
        'base64',
      ),
    );

    expect(output.pdf).toMatchObject({
      unit: 'pt',
      page: { width: 612, height: 792, orientation: 'portrait' },
    });
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const image: ScanPdfArea = output.pdf?.image ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    expect(Math.min(image.x, image.y)).toBeCloseTo(36);
    expect(output.pdf?.pixelsPerPoint).toBeCloseTo(output.width / image.width);
  });

  it('returns an image as image content, named after the file', async (): Promise<void> => {
    const result: CallToolResult = await scan(client, {
      imagePath: join(directory, 'photo.png'),
      outputFormat: 'image',
      filter: 'bw',
      rotation: 90,
    });
    const image: ImageContent = result.content[0] as ImageContent;

    expect(image.type).toBe('image');
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe(
      'PNG',
    );
    expect(result.structuredContent).toMatchObject({
      fileName: 'photo.png',
      mimeType: 'image/png',
    });
    expect(result.structuredContent).not.toHaveProperty('pdf');
  });

  it('saves the file to outputPath', async (): Promise<void> => {
    const result: CallToolResult = await scan(client, {
      imageBase64: PHOTO.toString('base64'),
      fileName: 'invoice.pdf',
      outputPath: directory,
    });

    expect(result.structuredContent).toMatchObject({
      fileName: 'invoice.pdf',
      savedTo: join(directory, 'invoice.pdf'),
    });
    expect(
      (await readFile(join(directory, 'invoice.pdf')))
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
  });

  it('uses the whole image when asked to', async (): Promise<void> => {
    const result: CallToolResult = await scan(client, {
      imageBase64: createBlankPhoto().toString('base64'),
      outputFormat: 'image',
      onNotDetected: 'original',
    });

    expect(result.structuredContent).toMatchObject({
      detected: false,
      corners: null,
      width: 600,
      height: 400,
    });
  });

  it('returns a tool error when no document is detected', async (): Promise<void> => {
    const result: CallToolResult = await scan(client, {
      imageBase64: createBlankPhoto().toString('base64'),
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toBe('No document detected in the image');
  });

  it('returns a tool error for invalid arguments', async (): Promise<void> => {
    const result: CallToolResult = await scan(client, {
      imageBase64: PHOTO.toString('base64'),
      jpegQuality: 101,
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('jpegQuality');
  });

  describe('with the http transport', (): void => {
    let httpClient: Client;

    beforeAll(async (): Promise<void> => {
      httpClient = await connect('http');
    });

    afterAll(async (): Promise<void> => {
      await httpClient.close();
    });

    it('refuses imagePath', async (): Promise<void> => {
      const result: CallToolResult = await scan(httpClient, {
        imagePath: join(directory, 'photo.png'),
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain(
        'imagePath is only available with the stdio transport',
      );
    });

    it('refuses outputPath', async (): Promise<void> => {
      const result: CallToolResult = await scan(httpClient, {
        imageBase64: PHOTO.toString('base64'),
        outputPath: directory,
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        'outputPath is only available with the stdio transport',
      );
    });
  });
});
