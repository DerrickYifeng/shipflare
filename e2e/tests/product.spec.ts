import { testWithProduct, expect } from '../fixtures/auth';

testWithProduct.describe('Product page', () => {
  testWithProduct('renders the product heading and editable fields', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/product');

    // Header rendered
    await expect(page.getByRole('heading', { name: 'My Product' })).toBeVisible();

    // Field rows visible
    await expect(page.getByText('Name')).toBeVisible();
    await expect(page.getByText('Description')).toBeVisible();
    await expect(page.getByText('Keywords')).toBeVisible();
    await expect(page.getByText('State')).toBeVisible();
    await expect(page.getByText('Phase')).toBeVisible();
  });

  testWithProduct('name field is click-to-edit', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/product');

    // The Name field row should contain an editable button or input
    const nameRow = page.locator('text=Name').locator('..').locator('..');
    await expect(nameRow).toBeVisible();

    // Click the editable value inside the Name row — it becomes an input
    const editableBtn = nameRow.getByRole('button').first();
    await editableBtn.click();

    // An input should appear
    await expect(nameRow.getByRole('textbox')).toBeVisible();

    // Escape cancels
    await page.keyboard.press('Escape');
    await expect(nameRow.getByRole('textbox')).not.toBeVisible();
  });
});
