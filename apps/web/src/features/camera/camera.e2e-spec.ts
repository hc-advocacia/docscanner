import {
  type BrowserContext,
  expect,
  type FileChooser,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

import {
  documentTiles,
  editorCorners,
  FIXTURE_CORNERS,
  fixturePath,
  maxCornerError,
  openApp,
  type Point,
  type Quad,
  uploadImages,
} from '@/test-support/e2e/app';

/** Size of the frames of the fake camera (`camera.y4m`). */
const FRAME_WIDTH: number = 640;
const FRAME_HEIGHT: number = 480;

/**
 * Where the invoice sheet is in a frame of the fake camera: the camera films the invoice photo
 * (1600 × 1200) scaled down to its frame size.
 */
const CAMERA_CORNERS: Quad = FIXTURE_CORNERS['invoice.jpg'].map(
  (point: Point): Point => ({
    x: (point.x * FRAME_WIDTH) / 1600,
    y: (point.y * FRAME_HEIGHT) / 1200,
  }),
) as Quad;

/** How far, in frame pixels, a detected corner may be from the real one. */
const CORNER_TOLERANCE: number = 16;

/** The camera playing: the video has frames and the shutter is enabled. */
async function expectCameraReady(page: Page): Promise<void> {
  await expect(page.getByTestId('camera-video')).toBeVisible();
  await expect(page.getByTestId('shutter')).toBeEnabled();
  await expect
    .poll(async (): Promise<number> =>
      page
        .getByTestId('camera-video')
        .evaluate((video: HTMLVideoElement): number => video.videoWidth),
    )
    .toBe(FRAME_WIDTH);
}

/** Takes one photo and waits until the camera counts it. */
async function takePhoto(page: Page, expectedCount: number): Promise<void> {
  await page.getByTestId('shutter').click();
  await expect(page.locator('.camera-done-count')).toHaveText(
    String(expectedCount),
  );
}

/**
 * Starts recording whether an import begins from now on: the import progress shows up as soon as
 * images are added, and stays at least a second, so an import started by mistake is caught even
 * after its documents would have arrived.
 */
async function watchForImports(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const state: { importStarted: boolean } = window as unknown as {
      importStarted: boolean;
    };
    state.importStarted = false;
    const check = (): void => {
      if (document.querySelector('[data-testid="loading-overlay"]'))
        state.importStarted = true;
    };
    new MutationObserver(check).observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

/** Whether an import began since `watchForImports`. */
async function importStarted(page: Page): Promise<boolean> {
  return page.evaluate(
    (): boolean =>
      (window as unknown as { importStarted: boolean }).importStarted,
  );
}

/** What the page asked `getUserMedia` for, and the tracks it got, recorded by `recordCamera`. */
interface CameraRecord {
  constraints: (MediaStreamConstraints | undefined)[];
  tracks: MediaStreamTrack[];
}

/** Records every camera request of the page and the tracks it gets back. */
async function recordCamera(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const record: CameraRecord = { constraints: [], tracks: [] };
    (window as unknown as { cameraRecord: CameraRecord }).cameraRecord = record;
    const original: (
      constraints?: MediaStreamConstraints,
    ) => Promise<MediaStream> = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (
      constraints?: MediaStreamConstraints,
    ): Promise<MediaStream> => {
      record.constraints.push(constraints);
      const stream: MediaStream = await original(constraints);
      record.tracks.push(...stream.getTracks());
      return stream;
    };
  });
}

/** Kind and state of every track the camera gave the page. */
async function cameraTracks(page: Page): Promise<string[]> {
  return page.evaluate((): string[] =>
    (
      window as unknown as { cameraRecord: CameraRecord }
    ).cameraRecord.tracks.map(
      (track: MediaStreamTrack): string => `${track.kind}:${track.readyState}`,
    ),
  );
}

test.describe('camera, with permission', (): void => {
  test.beforeEach(
    async ({ context }: { context: BrowserContext }): Promise<void> => {
      await context.grantPermissions(['camera']);
    },
  );

  test('"Take photo" on the empty Upload step opens the camera with the live video', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    // With the in-app camera, "Upload images" opens a plain file picker, not the native camera
    await expect(page.getByTestId('file-input')).not.toHaveAttribute('capture');
    await page.getByTestId('upload-camera').click();

    await expectCameraReady(page);
    // The camera covers the step: the empty upload card is gone, the top bar stays on Upload
    await expect(page.getByTestId('upload-files')).toBeHidden();
    await expect(page.getByTestId('step-0')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'Enquadre o documento' }),
    ).toBeVisible();
    // Nothing to finish yet
    const done: Locator = page.getByTestId('camera-done');
    await expect(done).toBeDisabled();
    await expect(done).toHaveAccessibleName('Concluir');
    const playing: boolean = await page
      .getByTestId('camera-video')
      .evaluate(
        (video: HTMLVideoElement): boolean =>
          !video.paused && video.srcObject instanceof MediaStream,
      );
    expect(playing).toBe(true);
  });

  test('takes two photos in a row, counting them, and Done imports them as two documents with the invoice detected', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await page.getByTestId('upload-camera').click();
    await expectCameraReady(page);

    await takePhoto(page, 1);
    await expect(
      page.getByText('1 foto · tire a próxima ou conclua'),
    ).toBeVisible();
    await expect(page.getByTestId('camera-done')).toHaveAccessibleName(
      'Concluir com 1 foto',
    );
    // The camera stays open for the next photo
    await expect(page.getByTestId('shutter')).toBeEnabled();

    await takePhoto(page, 2);
    await expect(
      page.getByText('2 fotos · tire a próxima ou conclua'),
    ).toBeVisible();
    await expect(page.getByTestId('camera-done')).toHaveAccessibleName(
      'Concluir com 2 fotos',
    );

    await page.getByTestId('camera-done').click();

    // Back on the Upload step, with both photos imported in the carousel
    await expect(page.getByTestId('camera-video')).toBeHidden();
    await expect(documentTiles(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });
    await expect(
      page.getByRole('heading', { name: 'Você enviou 2 imagens' }),
    ).toBeVisible();
    await expect(page.getByTestId('step-0')).toHaveAttribute(
      'aria-current',
      'step',
    );

    // Each photo is a frame of the camera, with the invoice found in it
    await page.getByTestId('upload-continue').click();
    for (let i: number = 0; i < 2; i++) {
      await page.getByTestId(`doc-${String(i)}`).click();
      await expect(page.getByTestId(`doc-${String(i)}`)).toHaveAttribute(
        'aria-current',
        'true',
      );
      const image: Locator = page.getByTestId('corner-editor').locator('image');
      await expect(image).toHaveAttribute('width', String(FRAME_WIDTH));
      await expect(image).toHaveAttribute('height', String(FRAME_HEIGHT));
      expect(
        maxCornerError(await editorCorners(page), CAMERA_CORNERS),
      ).toBeLessThan(CORNER_TOLERANCE);
    }
    await expect(page.getByTestId('crop')).toBeEnabled();
  });

  test('Back without photos closes the camera and imports nothing', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await page.getByTestId('upload-camera').click();
    await expectCameraReady(page);

    await page.getByRole('button', { name: 'Voltar', exact: true }).click();

    await expect(page.getByTestId('camera-video')).toBeHidden();
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(documentTiles(page)).toHaveCount(0);
    await expect(page.getByTestId('step-1')).toBeDisabled();
  });

  test('Back after taking photos discards them', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await page.getByTestId('upload-camera').click();
    await expectCameraReady(page);
    await takePhoto(page, 1);
    await watchForImports(page);

    await page.getByRole('button', { name: 'Voltar', exact: true }).click();

    await expect(page.getByTestId('upload-files')).toBeVisible();
    // Opening the camera again starts from zero photos; by the time it plays, an import started
    // by Back would already be on screen
    await page.getByTestId('upload-camera').click();
    await expectCameraReady(page);
    await expect(page.getByTestId('camera-done')).toBeDisabled();
    await expect(page.locator('.camera-done-count')).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'Enquadre o documento' }),
    ).toBeVisible();
    expect(await importStarted(page)).toBe(false);

    await page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(documentTiles(page)).toHaveCount(0);
    expect(await importStarted(page)).toBe(false);
  });

  test('asks only for the rear camera, without the microphone', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await recordCamera(page);
    await page.getByTestId('upload-camera').click();
    await expectCameraReady(page);

    const constraints: (MediaStreamConstraints | undefined)[] =
      await page.evaluate(
        (): (MediaStreamConstraints | undefined)[] =>
          (window as unknown as { cameraRecord: CameraRecord }).cameraRecord
            .constraints,
      );
    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.audio).toBe(false);
    expect(constraints[0]?.video).toMatchObject({
      facingMode: { ideal: 'environment' },
    });
    expect(await cameraTracks(page)).toEqual(['video:live']);
  });

  for (const closing of ['Back', 'Done'] as const) {
    test(`the camera turns off when it closes with ${closing}`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await openApp(page);
      // Keeps the streams the app opens, to check their tracks after the camera closes
      await recordCamera(page);
      await page.getByTestId('upload-camera').click();
      await expectCameraReady(page);
      expect(await cameraTracks(page)).toEqual(['video:live']);

      if (closing === 'Back') {
        await page.getByRole('button', { name: 'Voltar', exact: true }).click();
      } else {
        await takePhoto(page, 1);
        await page.getByTestId('camera-done').click();
      }
      await expect(page.getByTestId('camera-video')).toHaveCount(0);

      await expect
        .poll(async (): Promise<string[]> => cameraTracks(page))
        .toEqual(['video:ended']);
      if (closing === 'Done') {
        await expect(documentTiles(page)).toHaveCount(1, { timeout: 60_000 });
      }
      // Closing never opens the camera again
      expect(await cameraTracks(page)).toEqual(['video:ended']);
    });
  }

  test('opens from the carousel in Crop, adds the photo as the last document and comes back to Crop', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['receipt.jpg']);
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );

    await page.getByTestId('add-camera').click();
    await expectCameraReady(page);
    // The top bar keeps showing the step the camera was opened from
    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('corner-editor')).toBeHidden();

    await takePhoto(page, 1);
    await page.getByTestId('camera-done').click();

    await expect(documentTiles(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });
    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('corner-editor')).toBeVisible();

    // The photo is the second document, after the receipt, already selected, with the invoice
    // detected
    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('doc-0')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(
      page.getByTestId('corner-editor').locator('image'),
    ).toHaveAttribute('width', String(FRAME_WIDTH));
    expect(
      maxCornerError(await editorCorners(page), CAMERA_CORNERS),
    ).toBeLessThan(CORNER_TOLERANCE);
    await page.getByTestId('doc-0').click();
    await expect(
      page.getByTestId('corner-editor').locator('image'),
    ).toHaveAttribute('width', '1400');
  });

  test('Back from the camera opened in Crop returns to the same document in Crop', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);
    await page.getByTestId('upload-continue').click();
    await page.getByTestId('doc-1').click();
    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );

    await page.getByTestId('add-camera').click();
    await expectCameraReady(page);
    await page.getByRole('button', { name: 'Voltar', exact: true }).click();

    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(documentTiles(page)).toHaveCount(2);
    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
});

/**
 * Makes the browser refuse the camera with a `DOMException` of the given name. The fake media UI of
 * the test browser accepts every camera request, so a denied or missing camera is simulated here.
 */
async function refuseCamera(page: Page, errorName: string): Promise<void> {
  await page.addInitScript((name: string): void => {
    MediaDevices.prototype.getUserMedia = async (): Promise<MediaStream> => {
      await Promise.resolve();
      throw new DOMException('Refused by the test', name);
    };
  }, errorName);
}

test.describe('camera errors and fallback', (): void => {
  const ERRORS: { name: string; reason: string; message: string }[] = [
    {
      name: 'NotAllowedError',
      reason: 'access is denied',
      message:
        'O acesso à câmera foi negado. Libere a permissão nas configurações do navegador e tente de novo.',
    },
    {
      name: 'NotFoundError',
      reason: 'there is no camera',
      message: 'Nenhuma câmera encontrada neste dispositivo.',
    },
    {
      name: 'NotReadableError',
      reason: 'the camera fails to start',
      message: 'Não foi possível abrir a câmera.',
    },
  ];

  for (const { name, reason, message } of ERRORS) {
    test(`when ${reason}, shows the error and keeps the shutter and Done disabled`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await refuseCamera(page, name);
      await openApp(page);
      await page.getByTestId('upload-camera').click();

      const toast: Locator = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast).toHaveAttribute('data-kind', 'error');
      await expect(toast).toHaveText(message);
      await expect(page.getByRole('alert')).toHaveText(message);
      await expect(page.getByTestId('shutter')).toBeDisabled();
      await expect(page.getByTestId('camera-done')).toBeDisabled();
      // No framing hint over a camera that does not play
      await expect(page.getByText('Enquadre o documento')).toBeHidden();

      // Back still leads to the upload options, with nothing imported
      await page.getByRole('button', { name: 'Voltar', exact: true }).click();
      await expect(page.getByTestId('upload-files')).toBeVisible();
      await expect(documentTiles(page)).toHaveCount(0);
    });
  }

  test('without camera support, "Take photo" opens the file picker with the native camera and imports the photo', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    // As on plain HTTP, where browsers do not expose getUserMedia
    await page.addInitScript((): void => {
      Object.defineProperty(Navigator.prototype, 'mediaDevices', {
        configurable: true,
        get: (): undefined => undefined,
      });
    });
    await openApp(page);
    await expect(page.getByTestId('file-input')).toHaveAttribute(
      'capture',
      'environment',
    );

    const chooserShown: Promise<FileChooser> = page.waitForEvent('filechooser');
    await page.getByTestId('upload-camera').click();
    const chooser: FileChooser = await chooserShown;
    expect(chooser.isMultiple()).toBe(true);
    await expect(page.getByTestId('camera-video')).toHaveCount(0);

    await chooser.setFiles(fixturePath('invoice.jpg'));
    await expect(documentTiles(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });
    await expect(
      page.getByRole('heading', { name: 'Você enviou 1 imagem' }),
    ).toBeVisible();
    // The in-app camera never opened, so no camera error either
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});
