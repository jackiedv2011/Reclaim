import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { CountUp } from './CountUp'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('settles on the exact value when the browser never runs an animation frame', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const { rerender } = render(<CountUp value={1234.56} format={(v) => `$${v.toFixed(2)}`} />)
  expect(screen.getByText('$0.00')).toBeInTheDocument()
  act(() => { vi.advanceTimersByTime(2000) })
  expect(screen.getByText('$1234.56')).toBeInTheDocument()
  rerender(<CountUp value={10} format={(v) => `$${v.toFixed(2)}`} />)
  act(() => { vi.advanceTimersByTime(2000) })
  expect(screen.getByText('$10.00')).toBeInTheDocument()
})
