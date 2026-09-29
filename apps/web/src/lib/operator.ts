import { useCallback, useState } from "react";

// 「操作人」只是自填的名字，存在浏览器本地，服务端不校验。
const KEY = "shipyard:operator";

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function useOperatorName(): [string, (name: string) => void] {
  const [name, setName] = useState(read);
  const update = useCallback((next: string) => {
    setName(next);
    try {
      if (next.trim()) localStorage.setItem(KEY, next.trim());
      else localStorage.removeItem(KEY);
    } catch {
      // private mode etc. — keep it in memory only
    }
  }, []);
  return [name, update];
}
