
export type HighLow = {
    high: number,
    low:number,
}
export const findHighAndLowValues = async (data: string[]): Promise<HighLow> => {
    let high: number = Number.MIN_SAFE_INTEGER;
    let low: number = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < data.length; i++) {
      const value: number = parseFloat(data[i]);
      if (value > high) {
        high = value;
      }
      if (value < low) {
        low = value;
      }
    }
    return { high, low };
  }