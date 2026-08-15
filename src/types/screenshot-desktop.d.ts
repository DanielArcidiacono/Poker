declare module "screenshot-desktop" {
  type ScreenshotOptions = {
    format?: "png" | "jpg";
    screen?: number | string;
    filename?: string;
  };

  function screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  namespace screenshot {
    function listDisplays(): Promise<Array<{ id: number | string; name: string }>>;
  }

  export default screenshot;
}
