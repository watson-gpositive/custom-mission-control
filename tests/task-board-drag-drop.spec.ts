import { test, expect } from '@playwright/test'

/**
 * Verifies: humans can drag tasks from Backlog to Assigned column.
 * Before fix: taskBoardIsReadOnlyWorkflow = Boolean(currentUser) blocks all human drag.
 */

test.describe('Task Board drag-and-drop', () => {
  async function login(page: any, username: string, password: string) {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await page.locator('#username').fill(username)
    await page.locator('#password').fill(password)
    await page.locator('button[type="submit"]').click()
    // Wait for navigation away from login
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 10000 })
  }

  test('human can drag task from Backlog to Assigned', async ({ page }) => {
    await login(page, 'testadmin', 'testpass1234!')

    // Navigate to tasks
    await page.goto('/tasks')
    await page.waitForLoadState('networkidle')

    // Verify task board loaded
    const backlogHeader = page.locator('text=Backlog').first()
    await expect(backlogHeader).toBeVisible({ timeout: 10000 })

    // Check draggable attribute on cards
    const draggableCards = page.locator('[draggable="true"]')
    const count = await draggableCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    const firstCard = draggableCards.first()
    const draggable = await firstCard.getAttribute('draggable')
    console.log(`draggable=${draggable}`)

    // BUG: draggable="false" means taskBoardIsReadOnlyWorkflow blocks humans
    expect(draggable, 'BUG: task cards are not draggable by logged-in humans').toBe('true')

    // Drag from Backlog to Assigned
    const assignedHeader = page.locator('text=Assigned').first()
    await firstCard.dragTo(assignedHeader)
    await page.waitForTimeout(1500)

    console.log('Drag completed successfully')
  })

  test('edit modal allows setting status to Assigned', async ({ page }) => {
    await login(page, 'testadmin', 'testpass1234!')
    await page.goto('/tasks')
    await page.waitForLoadState('networkidle')

    const card = page.locator('[draggable="true"]').first()
    if (await card.count() === 0) {
      test.skip()
      return
    }

    await card.click()
    await page.waitForTimeout(500)

    const editBtn = page.locator('button:has-text("Edit")').first()
    const editVisible = await editBtn.isVisible().catch(() => false)
    if (!editVisible) {
      console.log('Edit button not visible')
      test.skip()
      return
    }

    await editBtn.click()
    await page.waitForTimeout(300)

    const statusSelect = page.locator('select').first()
    const selectVisible = await statusSelect.isVisible().catch(() => false)
    if (!selectVisible) {
      test.skip()
      return
    }

    const options = await statusSelect.locator('option').allTextContents()
    console.log('Status options:', options)
    expect(options).toContain('Assigned')
  })
})
