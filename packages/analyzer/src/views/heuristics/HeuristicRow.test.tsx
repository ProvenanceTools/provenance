import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeuristicRow, type HeuristicRowProps } from './HeuristicRow.js';

function renderRow(overrides: Partial<HeuristicRowProps> = {}) {
  const props: HeuristicRowProps = {
    id: 'large_paste',
    setting: { enabled: true, weight: 1 },
    modified: false,
    onWeightChange: vi.fn(),
    onEnabledChange: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  render(<HeuristicRow {...props} />);
  return props;
}

describe('HeuristicRow', () => {
  it('shows the humanized name with the raw id beneath, and the weight value', () => {
    renderRow({ setting: { enabled: true, weight: 1.5 } });
    expect(screen.getByText('Large paste')).toBeInTheDocument();
    expect(screen.getByText('large_paste')).toBeInTheDocument();
    expect(screen.getByText('1.5')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('keeps the 0.0–2.0 / 0.1-step range and reports weight changes', () => {
    const props = renderRow();
    const slider = screen.getByRole('slider', { name: 'large_paste' });
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '2');
    expect(slider).toHaveAttribute('step', '0.1');
    fireEvent.change(slider, { target: { value: '0.3' } });
    expect(props.onWeightChange).toHaveBeenCalledWith(0.3);
  });

  it('is an accessible checkbox switch that reports toggles', () => {
    const props = renderRow();
    const toggle = screen.getByRole('checkbox', { name: 'Enable large_paste' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(props.onEnabledChange).toHaveBeenCalledWith(false);
  });

  it('shows the modified dot and reset button only when modified', () => {
    renderRow();
    expect(screen.queryByTestId('modified-large_paste')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();
  });

  it('reset calls onReset', () => {
    const props = renderRow({ modified: true });
    expect(screen.getByTestId('modified-large_paste')).toHaveTextContent('Modified');
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset Large paste to the active setting' }),
    );
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it('disables only the slider when weight does not apply, with a described note', () => {
    renderRow({ weightDisabled: true });
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByRole('slider')).toHaveAccessibleDescription(/weight does not apply/i);
    expect(screen.getByRole('checkbox')).not.toBeDisabled();
  });

  it('disables both controls when inert, with a described note', () => {
    renderRow({ inert: true });
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toHaveAccessibleDescription(/no corpus source/i);
  });
});
