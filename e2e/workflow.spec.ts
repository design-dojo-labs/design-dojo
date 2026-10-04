import { expect, test, type Page } from '@playwright/test';

/** Types at the end of the active Monaco editor. */
async function typeAtEnd(page: Page, text: string) {
  await page.locator('[data-testid="editor"] .view-lines').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test('select a problem, code, build, test, submit, review, navigate findings, resubmit, restore', async ({ page }) => {
  // Prepare the toolchain once (no-op when the shared test cache is already prepared).
  await page.goto('/settings');
  const prepare = page.getByRole('button', { name: /Prepare toolchain/ });
  if (await prepare.isVisible()) {
    await prepare.click();
    await expect(page.getByText('Maven 3.9.16 cached')).toBeVisible({ timeout: 300_000 });
  }
  // Choose the mock reviewer (tests only; it is labelled MOCK everywhere).
  await page.getByRole('radio', { name: 'Mock (tests)' }).click();
  await expect(page.getByText('Mock provider is enabled')).toBeVisible();

  // Home → LLD dashboard → random easy problem → preview → start.
  await page.goto('/');
  await page.getByRole('link', { name: /Practice LLD/ }).click();
  await expect(page).toHaveURL(/\/lld$/);
  await page.getByRole('radio', { name: 'Easy' }).click();
  await page.getByRole('radio', { name: 'Senior' }).click();
  await expect(page.getByTestId('match-count')).toContainText('No bundled or saved problems match');
  await expect(page.getByRole('button', { name: 'Pick a random problem' })).toBeDisabled();
  await page.getByRole('radio', { name: 'SDE-1' }).click();
  await page.getByRole('button', { name: 'Pick a random problem' }).click();
  await expect(page.getByRole('heading', { name: 'Functional requirements' })).toBeVisible();
  await expect(page.getByText(/Scoring rubric \(rubric\.v2/)).toBeVisible();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.getByRole('tab', { name: /Main\.java/ })).toBeVisible();

  // Multi-file editing with autosave.
  await page.getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('treeitem', { name: /pom\.xml/ })).toBeVisible();
  await typeAtEnd(page, '// e2e: first edit');
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 15_000 });

  // Compile and test.
  await page.getByRole('button', { name: 'Compile' }).click();
  await expect(page.getByTestId('console-output')).toContainText('Compilation succeeded', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Run tests' }).click();
  await expect(page.getByTestId('console-output')).toContainText('Tests: 1 passed', { timeout: 120_000 });

  // Submit → snapshot build → (mock) review → backend score.
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('review-score')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('MOCK').first()).toBeVisible();
  await expect(page.getByTestId('design-assessment')).toContainText('Single responsibility');

  // Clicking a finding opens the immutable snapshot at the cited line.
  const finding = page.getByTestId('finding').first();
  await finding.getByRole('button', { name: /Main\.java:1/ }).click();
  await expect(page.getByRole('tab', { name: /#1.*Main\.java/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Submitted snapshot #1, read-only')).toBeVisible();
  await expect(page.locator('.finding-highlight').first()).toBeAttached();
  // Separate option for the current working version.
  await page.getByRole('button', { name: 'Open working copy' }).click();
  await expect(page.getByRole('tab', { name: /^Main\.java/ })).toHaveAttribute('aria-selected', 'true');

  // Edit and resubmit; compare with the first submission.
  await typeAtEnd(page, '// e2e: second edit');
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 15_000 });
  await page.getByTestId('submit').click();
  await expect(page.getByRole('button', { name: /Compare with #1/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('review-score')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /Compare with #1/ }).click();
  await expect(page.getByRole('dialog', { name: 'Compare submissions' })).toContainText('modified');
  await page.keyboard.press('Escape');

  // Refresh: tabs, files and reviews are restored from the server.
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Main\.java/ })).toBeVisible();
  await expect(page.locator('[data-testid="editor"]')).toContainText('second edit');
  await expect(page.getByTestId('review-score')).toBeVisible();
});

test('HLD: pick a question, write requirements, draw components, submit, review, highlight', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Mock (tests)' }).click();
  await page.goto('/');
  await page.getByRole('link', { name: /Practice HLD/ }).click();
  await page.getByRole('radio', { name: 'Easy' }).click();
  await page.getByRole('radio', { name: 'Beginner' }).click();
  await page.getByRole('button', { name: 'Random from the bank' }).click();
  await expect(page.getByRole('heading', { name: 'Scale' })).toBeVisible();
  // The evaluation guide stays hidden until the first submission.
  await expect(page.getByText('Evaluation guide (revealed after submission)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start designing' }).click();
  await expect(page).toHaveURL(/\/hld\/session\//);

  await page.getByRole('button', { name: 'Add functional requirement' }).click();
  await page.keyboard.type('Create a short link');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Redirect to the long URL');
  await expect(page.getByTestId('hld-save-state')).toHaveText('All changes saved', { timeout: 15_000 });

  await page.getByRole('tab', { name: /Architecture/ }).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByRole('button', { name: /^Client$/ }).click();
  await page.getByRole('button', { name: /^Service$/ }).click();
  await page.getByRole('button', { name: /^Database$/ }).click();
  await expect(page.getByTestId('hld-save-state')).toHaveText('All changes saved', { timeout: 15_000 });

  await page.getByTestId('hld-submit').click();
  await expect(page.getByTestId('hld-review-score')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('MOCK').first()).toBeVisible();
  await expect(page.getByText('Evaluation guide (revealed after submission)')).toBeVisible({ timeout: 15_000 });
  // The mock improvement cites the first component; clicking it selects it on the canvas.
  await page.getByRole('button', { name: 'Client', exact: true }).last().click();
  await expect(page.getByText(/No component labelled/)).toHaveCount(0);
  await page.getByRole('button', { name: 'View submitted design' }).click();
  const modal = page.getByRole('dialog', { name: /Submitted design #1/ });
  await expect(modal).toContainText('What the reviewer received');
  await expect(modal).toContainText('Database');
});
