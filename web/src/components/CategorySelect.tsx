import type { Category } from "../lib/types";
import { Select, SelectItem } from "./ui/Select";

/** "" means no category (no done protocol), "auto" lets Claude pick one. */
export function CategorySelect({ value, onChange, categories, allowNone = true }: { value: string; onChange: (value: string) => void; categories: Category[]; allowNone?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange}>
      {allowNone && <SelectItem value="">None (stays open until you stop it)</SelectItem>}
      <SelectItem value="auto">Auto (Claude picks one)</SelectItem>
      {categories.map((category) => (
        <SelectItem key={category.id} value={category.name}>
          {category.name}
        </SelectItem>
      ))}
    </Select>
  );
}
