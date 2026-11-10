import type { Corners, ScannedDocument } from '@devantage/docscanify';
import { render, screen, within } from '@testing-library/react';
import { type UserEvent, userEvent } from '@testing-library/user-event';
import type { JSX } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CameraProvider } from '@/features/camera/CameraProvider';
import { useCamera } from '@/features/camera/useCamera';
import type { ImportProgress } from '@/features/documents/useImportFiles';
import type { ScanContextValue } from '@/features/scan/ScanContext';
import { useScan } from '@/features/scan/useScan';
import { type Step, StepsProvider, useSteps } from '@/features/steps';
import { TranslateProvider } from '@/i18n';
import { DEFAULT_EXPORT_SETTINGS } from '@/lib/export';
import type { DocumentItem } from '@/lib/types';

import { AppHeader } from './AppHeader';

vi.mock('@/features/scan/useScan', () => ({
  useScan: vi.fn(),
  useActiveDocument: vi.fn(),
}));

const CORNERS: Corners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 100, y: 0 },
  bottomLeft: { x: 0, y: 100 },
  bottomRight: { x: 100, y: 100 },
};

/** A document with valid corners, named after its id. */
function makeDocument(id: string): DocumentItem {
  return {
    id,
    source: {
      image: new Image(),
      url: `blob:${id}`,
      name: id,
      scannedDocument: {} as ScannedDocument,
    },
    corners: CORNERS,
    valid: true,
    detectorFailed: false,
    options: { filter: 'none', turns: 0, sharpen: 'off' },
  };
}

interface ScanState {
  documents?: number;
  invalidCount?: number;
  importProgress?: ImportProgress | null;
}

/**
 * Makes {@link useScan} return `documents` documents with valid corners, the first one active, and
 * the given `invalidCount` and `importProgress`.
 */
function mockScan({
  documents = 0,
  invalidCount = 0,
  importProgress = null,
}: ScanState = {}): void {
  const list: DocumentItem[] = Array.from(
    { length: documents },
    (_: unknown, i: number) => makeDocument(`doc-${String(i)}`),
  );
  const value: ScanContextValue = {
    documents: list,
    active: list[0] ?? null,
    invalidCount,
    previews: {},
    importProgress,
    exportSettings: DEFAULT_EXPORT_SETTINGS,
    addFiles: vi.fn(),
    removeDocument: vi.fn(),
    reorder: vi.fn(),
    select: vi.fn(),
    setCorners: vi.fn(),
    redetect: vi.fn(),
    setOptions: vi.fn(),
    applyOptionsToAll: vi.fn(),
    setExportSettings: vi.fn(),
    restart: vi.fn(),
    dismissImportProgress: vi.fn(),
    setMainRender: vi.fn(),
    setDraggingCorner: vi.fn(),
  };
  vi.mocked(useScan).mockReturnValue(value);
}

/** Shows the step and the camera, and changes them as other parts of the app do. */
function Probe(): JSX.Element {
  const { step, goTo } = useSteps();
  const camera: ReturnType<typeof useCamera> = useCamera();
  const steps: Step[] = ['upload', 'crop', 'enhance', 'export'];
  return (
    <div>
      <output data-testid="probe">
        {step}/{camera.isOpen ? 'camera' : 'no-camera'}
      </output>
      <button type="button" onClick={camera.open}>
        probe-open-camera
      </button>
      {steps.map((s: Step) => (
        <button
          key={s}
          type="button"
          onClick={(): void => {
            goTo(s);
          }}
        >
          {`probe-${s}`}
        </button>
      ))}
    </div>
  );
}

/**
 * Renders the top bar with the real steps and camera, and a {@link Probe} on them.
 *
 * @param fixed Fixes the language, as the app does with `FIXED_LOCALE`.
 */
function renderHeader(fixed?: boolean): void {
  render(
    <TranslateProvider defaultLocale="pt-BR" fixed={fixed}>
      <StepsProvider>
        <CameraProvider>
          <AppHeader />
          <Probe />
        </CameraProvider>
      </StepsProvider>
    </TranslateProvider>,
  );
}

/** The four step buttons of the top bar, in order. */
function stepButtons(): HTMLElement[] {
  return [0, 1, 2, 3].map((i: number) => screen.getByTestId(`step-${i}`));
}

/** The list items of the steps, which carry the current and done classes. */
function stepItems(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Steps' })).getAllByRole(
    'listitem',
  );
}

describe('AppHeader', (): void => {
  it('shows the brand, the four steps in order and the language picker', (): void => {
    mockScan();
    renderHeader();

    expect(screen.getByRole('banner')).toHaveTextContent('DocScanner');
    expect(
      stepButtons().map(
        (b: HTMLElement) => b.querySelector('.step-label')?.textContent,
      ),
    ).toEqual(['Upload', 'Crop', 'Adjust', 'Export']);
    expect(
      stepButtons().map(
        (b: HTMLElement) => b.querySelector('.step-n')?.textContent,
      ),
    ).toEqual(['1', '2', '3', '4']);
    expect(
      within(screen.getByRole('banner')).getByTestId('language'),
    ).toBeInTheDocument();
  });

  it('hides the language picker when the language is fixed, and shows the steps in it', (): void => {
    mockScan();
    renderHeader(true);

    expect(
      within(screen.getByRole('banner')).queryByTestId('language'),
    ).not.toBeInTheDocument();
    expect(
      stepButtons().map(
        (b: HTMLElement) => b.querySelector('.step-label')?.textContent,
      ),
    ).toEqual(['Enviar', 'Recortar', 'Ajustar', 'Exportar']);
  });

  it('translates the step names', (): void => {
    localStorage.setItem('docscanify.locale', 'pt-BR');
    mockScan();
    renderHeader();

    expect(screen.getByRole('list', { name: 'Etapas' })).toBeInTheDocument();
    expect(
      stepButtons().map(
        (b: HTMLElement) => b.querySelector('.step-label')?.textContent,
      ),
    ).toEqual(['Enviar', 'Recortar', 'Ajustar', 'Exportar']);
  });

  describe('current and finished steps', (): void => {
    it('marks Upload as the current step at the start, with nothing finished', (): void => {
      mockScan();
      renderHeader();

      expect(
        stepButtons().map((b: HTMLElement) => b.getAttribute('aria-current')),
      ).toEqual(['step', null, null, null]);
      expect(stepItems().map((li: HTMLElement) => li.className)).toEqual([
        'is-current',
        '',
        '',
        '',
      ]);
    });

    it('checks the steps before the current one and numbers the rest', async (): Promise<void> => {
      mockScan({ documents: 2 });
      const user: UserEvent = userEvent.setup();
      renderHeader();

      await user.click(screen.getByRole('button', { name: 'probe-enhance' }));

      expect(stepItems().map((li: HTMLElement) => li.className)).toEqual([
        'is-done',
        'is-done',
        'is-current',
        '',
      ]);
      expect(
        stepButtons().map((b: HTMLElement) => b.getAttribute('aria-current')),
      ).toEqual([null, null, 'step', null]);
      const numbers: (Element | null)[] = stepButtons().map((b: HTMLElement) =>
        b.querySelector('.step-n'),
      );
      expect(numbers[0]?.querySelector('svg')).not.toBeNull();
      expect(numbers[0]).toHaveTextContent(/^$/);
      expect(numbers[1]?.querySelector('svg')).not.toBeNull();
      expect(numbers[2]).toHaveTextContent(/^3$/);
      expect(numbers[3]).toHaveTextContent(/^4$/);
    });

    it('marks every earlier step as finished on Export', async (): Promise<void> => {
      mockScan({ documents: 1 });
      const user: UserEvent = userEvent.setup();
      renderHeader();

      await user.click(screen.getByRole('button', { name: 'probe-export' }));

      expect(stepItems().map((li: HTMLElement) => li.className)).toEqual([
        'is-done',
        'is-done',
        'is-done',
        'is-current',
      ]);
    });
  });

  describe('which steps open', (): void => {
    it('only Upload opens without documents', (): void => {
      mockScan({ documents: 0 });
      renderHeader();

      expect(
        stepButtons().map((b: HTMLElement) => b.hasAttribute('disabled')),
      ).toEqual([false, true, true, true]);
    });

    it('Crop opens with documents, but not Adjust and Export while a crop needs fixing', (): void => {
      mockScan({ documents: 3, invalidCount: 1 });
      renderHeader();

      expect(
        stepButtons().map((b: HTMLElement) => b.hasAttribute('disabled')),
      ).toEqual([false, false, true, true]);
    });

    it('every step opens once every document has a valid crop', (): void => {
      mockScan({ documents: 2, invalidCount: 0 });
      renderHeader();

      expect(
        stepButtons().map((b: HTMLElement) => b.hasAttribute('disabled')),
      ).toEqual([false, false, false, false]);
    });

    it('no step opens while images are imported, not even the current one', (): void => {
      mockScan({
        documents: 2,
        importProgress: {
          phase: 'detecting',
          current: 1,
          total: 2,
          value: 0.4,
        },
      });
      renderHeader();

      expect(
        stepButtons().map((b: HTMLElement) => b.hasAttribute('disabled')),
      ).toEqual([true, true, true, true]);
    });
  });

  describe('opening a step', (): void => {
    it('goes to the pressed step', async (): Promise<void> => {
      mockScan({ documents: 1 });
      const user: UserEvent = userEvent.setup();
      renderHeader();

      await user.click(screen.getByRole('button', { name: /Adjust/ }));

      expect(screen.getByTestId('probe')).toHaveTextContent(
        'enhance/no-camera',
      );
      expect(screen.getByTestId('step-2')).toHaveAttribute(
        'aria-current',
        'step',
      );
    });

    it('closes the camera when opening another step', async (): Promise<void> => {
      mockScan({ documents: 1 });
      const user: UserEvent = userEvent.setup();
      renderHeader();
      await user.click(
        screen.getByRole('button', { name: 'probe-open-camera' }),
      );
      expect(screen.getByTestId('probe')).toHaveTextContent('upload/camera');

      await user.click(screen.getByRole('button', { name: /Crop/ }));

      expect(screen.getByTestId('probe')).toHaveTextContent('crop/no-camera');
    });

    it('closes the camera when pressing the current step', async (): Promise<void> => {
      mockScan();
      const user: UserEvent = userEvent.setup();
      renderHeader();
      await user.click(
        screen.getByRole('button', { name: 'probe-open-camera' }),
      );

      await user.click(screen.getByRole('button', { name: /Upload/ }));

      expect(screen.getByTestId('probe')).toHaveTextContent('upload/no-camera');
    });

    it('does nothing on a step that is not open yet', async (): Promise<void> => {
      mockScan({ documents: 1, invalidCount: 1 });
      const user: UserEvent = userEvent.setup();
      renderHeader();

      await user.click(screen.getByTestId('step-3'));

      expect(screen.getByTestId('probe')).toHaveTextContent('upload/no-camera');
    });
  });
});
