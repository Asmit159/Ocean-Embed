import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

interface DateStepperProps {
  date: Date;
  onChange: (d: Date) => void;
  maxDate?: Date;
}

const EditableNumber: React.FC<{
  value: number;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
}> = ({ value, onChange, min, max }) => {
  const [isEditing, setIsEditing] = React.useState(false);
  const [tempValue, setTempValue] = React.useState(value.toString());

  React.useEffect(() => {
    setTempValue(value.toString());
  }, [value]);

  const handleBlur = () => {
    setIsEditing(false);
    let parsed = parseInt(tempValue, 10);
    if (!isNaN(parsed)) {
      if (min !== undefined) parsed = Math.max(min, parsed);
      if (max !== undefined) parsed = Math.min(max, parsed);
      onChange(parsed);
    } else {
      setTempValue(value.toString());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleBlur();
    }
  };

  if (isEditing) {
    return (
      <input
        autoFocus
        className="date-stepper-value date-stepper-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={tempValue}
        onChange={(e) => setTempValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    );
  }

  return (
    <span 
      className="date-stepper-value" 
      onClick={() => { setIsEditing(true); setTempValue(value.toString()); }}
      style={{ cursor: 'text' }}
      title="Click to edit"
    >
      {value}
    </span>
  );
};

const DateStepper: React.FC<DateStepperProps> = ({ date, onChange, maxDate }) => {
  const day = date.getDate();
  const month = date.getMonth();
  const year = date.getFullYear();

  const isNextDayDisabled = maxDate ? new Date(year, month, day + 1) > maxDate : false;
  const isNextMonthDisabled = maxDate ? new Date(year, month + 1, day) > maxDate : false;
  const isNextYearDisabled = maxDate ? new Date(year + 1, month, day) > maxDate : false;

  const stepDay = (delta: number) => {
    onChange(new Date(year, month, day + delta));
  };

  const stepMonth = (delta: number) => {
    onChange(new Date(year, month + delta, day));
  };

  const stepYear = (delta: number) => {
    onChange(new Date(year + delta, month, day));
  };

  return (
    <div className="date-stepper">
      {/* Day column */}
      <div className="date-stepper-column">
        <button
          className="date-stepper-chevron"
          onClick={() => stepDay(1)}
          aria-label="Next day"
          disabled={isNextDayDisabled}
        >
          <ChevronUp size={16} />
        </button>
        <EditableNumber
          value={day}
          onChange={(newDay) => onChange(new Date(year, month, newDay))}
        />
        <button
          className="date-stepper-chevron"
          onClick={() => stepDay(-1)}
          aria-label="Previous day"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      <div className="date-stepper-divider" />

      {/* Month column */}
      <div className="date-stepper-column">
        <button
          className="date-stepper-chevron"
          onClick={() => stepMonth(1)}
          aria-label="Next month"
          disabled={isNextMonthDisabled}
        >
          <ChevronUp size={16} />
        </button>
        <span className="date-stepper-value date-stepper-month">{MONTH_LABELS[month]}</span>
        <button
          className="date-stepper-chevron"
          onClick={() => stepMonth(-1)}
          aria-label="Previous month"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      <div className="date-stepper-divider" />

      {/* Year column */}
      <div className="date-stepper-column">
        <button
          className="date-stepper-chevron"
          onClick={() => stepYear(1)}
          aria-label="Next year"
          disabled={isNextYearDisabled}
        >
          <ChevronUp size={16} />
        </button>
        <EditableNumber
          value={year}
          onChange={(newYear) => onChange(new Date(newYear, month, day))}
        />
        <button
          className="date-stepper-chevron"
          onClick={() => stepYear(-1)}
          aria-label="Previous year"
        >
          <ChevronDown size={16} />
        </button>
      </div>
    </div>
  );
};

export default DateStepper;
