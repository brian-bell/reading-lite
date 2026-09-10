import { createRoot } from "react-dom/client";
import { ConnectedPrototype } from "./ConnectedPrototype";
import "../interface-directions/styles.css";
import "../interface-directions/ui.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<ConnectedPrototype/>);
