import './AppHeader.css';

import type { JSX } from 'react';

import { CheckIcon } from '@/components/icons';
import type { CameraContextValue } from '@/features/camera/CameraContext';
import { useCamera } from '@/features/camera/useCamera';
import { useScan } from '@/features/scan/useScan';
import { stepIndex, STEPS, useSteps } from '@/features/steps';
import { useTranslate } from '@/i18n';

import { LanguageSelect } from './LanguageSelect';

/**
 * Top bar: the brand, the steps (finished ones checked), and the language picker, unless the
 * language is fixed. Steps open only once the previous ones are done, and none while images are
 * imported. Opening a step, even the current one, closes the camera.
 */
export function AppHeader(): JSX.Element {
  const { t, fixed } = useTranslate();
  const { step, goTo } = useSteps();
  const camera: CameraContextValue = useCamera();
  const { documents, invalidCount, importProgress } = useScan();
  const current: number = stepIndex(step);
  const cropDone: boolean = documents.length > 0 && invalidCount === 0;
  // Crop needs documents; Enhance and Export need every document with valid corners
  const reachable: boolean[] = [true, documents.length > 0, cropDone, cropDone];

  return (
    <header className="topbar">
      <span className="brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" aria-hidden />
        <span className="brand-name">DocScanner</span>
      </span>
      <ol className="steps" aria-label={t('app.steps')}>
        {STEPS.map((item: (typeof STEPS)[number], i: number) => (
          <li
            key={item.id}
            className={
              i === current ? 'is-current' : i < current ? 'is-done' : ''
            }
          >
            <button
              type="button"
              className="step"
              disabled={!reachable[i] || !!importProgress}
              aria-current={i === current ? 'step' : undefined}
              onClick={() => {
                camera.close();
                goTo(item.id);
              }}
              data-testid={`step-${i}`}
            >
              <span className="step-n">
                {i < current ? <CheckIcon /> : i + 1}
              </span>
              <span className="step-label">{t(item.label)}</span>
            </button>
          </li>
        ))}
      </ol>
      {!fixed && <LanguageSelect />}
    </header>
  );
}
