// Reduced from syv-ai/flows/frontend/src/components/agents/CustomNode/
// LovgivningSearchField.test.tsx. Keep the parser-triggering TSX/type-query
// combination here without depending on that checkout.
import { vi } from 'vitest'
import type { EntityChoice } from '@/hooks/useEntityFetcher'

const fetcherState: {
  choices: EntityChoice[]
  loading: boolean
  error: string | null
} = { choices: [], loading: false, error: null }

vi.mock('@/hooks/useEntityFetcher', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/hooks/useEntityFetcher')>()
  return {
    ...actual,
    useEntityFetcher: () => ({
      choices: fetcherState.choices,
      loading: fetcherState.loading,
      error: fetcherState.error,
    }),
  }
})

const renderField = (
  props: Partial<Parameters<typeof LovgivningSearchField>[0]> = {},
) => (
  <LovgivningSearchField
    aar={props.aar}
    nummer={props.nummer}
    onSelect={vi.fn()}
  />
)

function setFetcher(overrides: Partial<typeof fetcherState>) {
  fetcherState.choices = overrides.choices ?? []
  fetcherState.loading = overrides.loading ?? false
  fetcherState.error = overrides.error ?? null
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'))
}

export { renderField, setFetcher, openPopover }
